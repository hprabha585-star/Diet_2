<?php
/* routes/admin.js — every route requires a signed-in admin (group middleware). */

function find_client($id) {
    if (!is_numeric($id)) respond(404, ['error' => 'Client not found']);
    $c = find_one('users', ['id' => (int)$id, 'role' => 'client']);
    if (!$c) respond(404, ['error' => 'Client not found']);
    return $c;
}
function bcrypt($pw) { return password_hash((string)$pw, PASSWORD_BCRYPT, ['cost' => 10]); }

/* ---------------- Clients / roster ---------------- */
route('POST', '/clients', function () {
    $name = in_body('name'); $email = in_body('email'); $phone = in_body('phone');
    $password = in_body('password'); $tier = in_body('tier'); $activateNow = in_body('activateNow');
    if (!truthy($name) || !truthy($email) || !truthy($password)) respond(400, ['error' => 'Name, email and password are required']);
    if (strlen($password) < 6) respond(400, ['error' => 'Password must be at least 6 characters']);
    if (find_one('users', ['email' => strtolower($email)])) respond(409, ['error' => 'An account with this email already exists']);

    $planMode = 'protocol'; $status = 'pending_payment'; $start = null;
    if (truthy($tier)) { $plan = find_one('plans', ['key' => $tier]); if ($plan) $planMode = $plan['mode']; }
    if (truthy($activateNow)) { $status = 'active'; $start = today_local(); }

    $user = create('users', [
        'name' => $name, 'email' => strtolower($email), 'phone' => $phone, 'passwordHash' => bcrypt($password),
        'role' => 'client', 'tier' => truthy($tier) ? $tier : 'none', 'planMode' => $planMode, 'status' => $status,
        'challengeStartDate' => $start, 'referralCode' => unique_referral_code($name),
        'hasProtocolAccess' => truthy($activateNow) && $planMode === 'protocol',
        'hasTrackerAccess' => truthy($activateNow) && $planMode === 'tracker'
    ]);
    respond(201, ['user' => safe_user($user)]);
}, ['err' => 'Could not create client']);

route('GET', '/clients', function () {
    $out = [];
    foreach (find_all('users', ['role' => 'client'], [['createdAt', 'DESC']]) as $c) {
        $day = current_challenge_day($c);
        $hp = has_protocol_mode($c); $ht = has_tracker_mode($c);
        $regimen = null; $completion = null;
        if ($hp && $day > 0) {
            $regimen = find_one('regimens', ['userId' => $c['id'], 'day' => $day]);
            $log = find_one('checklist_logs', ['userId' => $c['id'], 'day' => $day]);
            $completion = $log ? $log['completionPercent'] : 0;
        }
        $out[] = [
            'id' => $c['id'], 'name' => $c['name'], 'email' => $c['email'], 'phone' => $c['phone'],
            'status' => $c['status'], 'planMode' => $c['planMode'], 'tier' => $c['tier'],
            'hasProtocolAccess' => $hp, 'hasTrackerAccess' => $ht, 'isDualAccess' => $hp && $ht,
            'timezone' => $c['timezone'], 'day' => $day, 'challengeLengthDays' => $c['challengeLengthDays'],
            'daysLeft' => days_left($c), 'dueDate' => due_date($c), 'expired' => is_expired($c),
            'points' => $c['points'], 'streakCurrent' => $c['streakCurrent'],
            'fastingPause' => ['active' => $c['pauseActive'], 'reason' => $c['pauseReason'], 'pausedBy' => $c['pausedBy']],
            'window' => $regimen ? ['startHour' => $regimen['startHour'], 'endHour' => $regimen['endHour'], 'isFullDayFast' => $regimen['isFullDayFast']] : null,
            'completionPercent' => $completion
        ];
    }
    return ['clients' => $out];
});

route('GET', '/clients/:id', function ($p) {
    $c = find_client($p['id']);
    $weightLogs = find_all('weight_logs', ['userId' => $c['id']], [['date', 'ASC']]);
    $regimens = array_map('attach_regimen_children', find_all('regimens', ['userId' => $c['id']], [['day', 'ASC']]));
    $checklistLogs = find_all('checklist_logs', ['userId' => $c['id']], [['day', 'ASC']]);
    $latest = $weightLogs ? $weightLogs[count($weightLogs) - 1]['weightKg'] : null;
    $first = $weightLogs ? $weightLogs[0]['weightKg'] : null;
    return [
        'client' => safe_user($c), 'weightLogs' => $weightLogs, 'regimens' => $regimens, 'checklistLogs' => $checklistLogs,
        'body' => [
            'heightCm' => $c['heightCm'], 'age' => $c['age'], 'gender' => $c['gender'],
            'currentWeightKg' => $latest, 'startWeightKg' => $first,
            'changeKg' => ($latest !== null && $first !== null) ? round1($latest - $first) : null,
            'bmi' => bmi_of($c, $latest), 'healthyWeightRange' => healthy_weight_range($c)
        ],
        'validity' => ['daysLeft' => days_left($c), 'dueDate' => due_date($c), 'expired' => is_expired($c)],
        'medical' => [
            'medicalConditions' => $c['medicalConditions'] ?: '', 'allergies' => $c['allergies'] ?: '',
            'medications' => $c['medications'] ?: '', 'medicalNotes' => $c['medicalNotes'] ?: ''
        ]
    ];
});

route('DELETE', '/clients/:id', function ($p) {
    $c = find_client($p['id']);
    destroy('users', ['id' => $c['id']]); // child rows cascade via foreign keys
    return ['ok' => true];
});

route('POST', '/clients/:id/activate', function ($p) {
    $c = find_client($p['id']);
    $ch = ['status' => 'active'];
    if (!$c['challengeStartDate']) $ch['challengeStartDate'] = today_local();
    return ['client' => safe_user(save('users', $c, $ch))];
});

route('POST', '/clients/:id/reset-password', function ($p) {
    $c = find_client($p['id']);
    $pw = in_body('password');
    if (!truthy($pw) || strlen($pw) < 6) respond(400, ['error' => 'Password must be at least 6 characters']);
    save('users', $c, ['passwordHash' => bcrypt($pw)]);
    return ['ok' => true];
});

route('POST', '/clients/:id/pause', function ($p) {
    $c = find_client($p['id']);
    if (truthy(in_body('pause'))) {
        $ch = ['pauseActive' => true, 'pauseReason' => truthy(in_body('reason')) ? in_body('reason') : '', 'pauseStartedAt' => now_db(), 'pausedBy' => 'admin'];
    } else {
        $ch = [];
        if ($c['pauseActive'] && $c['pauseStartedAt']) {
            $ch['pausedDays'] = ($c['pausedDays'] ?: 0) + max(0, day_diff(local_date($c['pauseStartedAt']), today_local()));
        }
        $ch += ['pauseActive' => false, 'pauseReason' => '', 'pausedBy' => null];
    }
    return ['client' => safe_user(save('users', $c, $ch))];
});

/* ---------------- 55-day protocol (editable reference data) ---------------- */
route('GET', '/protocol-defaults', function () {
    $days = protocol_days_all_or_seed();
    $phaseGoals = protocol_data()->PHASE_GOALS; $safety = protocol_data()->SAFETY_NOTES;
    try {
        $s = settings_get_or_create();
        if ($s['protocolPhaseGoals']) $phaseGoals = $s['protocolPhaseGoals'];
        if ($s['protocolSafetyNotes']) $safety = $s['protocolSafetyNotes'];
    } catch (Throwable $e) { error_log($e->getMessage()); }
    return ['days' => $days, 'phaseGoals' => $phaseGoals, 'safetyNotes' => $safety];
}, ['err' => 'Could not load the 55-day protocol']);

route('PUT', '/protocol-defaults/phase-info', function () {
    $s = settings_get_or_create();
    $ch = [];
    $pg = in_body('phaseGoals');
    if ($pg && is_array($pg)) $ch['protocolPhaseGoals'] = (object)$pg;
    if (is_array(in_body('safetyNotes')) && array_is_list(in_body('safetyNotes'))) $ch['protocolSafetyNotes'] = in_body('safetyNotes');
    $s = save('settings', $s, $ch);
    return ['phaseGoals' => $s['protocolPhaseGoals'], 'safetyNotes' => $s['protocolSafetyNotes']];
}, ['err' => 'Could not save phase info']);

route('PATCH', '/protocol-defaults/:day', function ($p) {
    $day = js_int($p['day']);
    $row = find_one('protocol_days', ['day' => $day]);
    if (!$row) respond(404, ['error' => "Day $day not found in the protocol"]);
    $ch = [];
    foreach (['phase', 'protocolType', 'label', 'focus'] as $f) if (is_string(in_body($f))) $ch[$f] = in_body($f);
    if (is_bool(in_body('isFullDayFast'))) $ch['isFullDayFast'] = in_body('isFullDayFast');
    if (has_body('waterTargetMl')) $ch['waterTargetMl'] = js_int(in_body('waterTargetMl')) ?: $row['waterTargetMl'];
    $full = $ch['isFullDayFast'] ?? $row['isFullDayFast'];
    if ($full) {
        $ch += ['startHour' => 9, 'endHour' => 9, 'eatingHours' => 0, 'fastingHours' => 24];
        $ch['startHour'] = 9; $ch['endHour'] = 9; $ch['eatingHours'] = 0; $ch['fastingHours'] = 24;
    } else {
        $start = has_body('startHour') ? js_float(in_body('startHour')) : $row['startHour'];
        $end = has_body('endHour') ? js_float(in_body('endHour')) : $row['endHour'];
        $eating = round1($end - $start);
        $ch += ['startHour' => $start, 'endHour' => $end];
        $ch['eatingHours'] = $eating; $ch['fastingHours'] = round1(24 - $eating);
    }
    return ['day' => save('protocol_days', $row, $ch)];
}, ['err' => 'Could not save that day']);

route('GET', '/meal-presets', function () {
    return ['presets' => data_json('meal_presets')];
});

/* ---------------- Assign plan ---------------- */
route('GET', '/clients/:id/regimen/:day', function ($p) {
    $r = load_regimen(js_int($p['id']), js_int($p['day']));
    if (!$r) return ['regimen' => null, 'assigned' => false];
    return ['assigned' => true, 'regimen' => [
        'day' => $r['day'], 'startHour' => $r['startHour'], 'endHour' => $r['endHour'],
        'isFullDayFast' => $r['isFullDayFast'], 'protocolType' => $r['protocolType'],
        'phase' => $r['phase'], 'focus' => $r['focus'], 'waterTargetMl' => $r['waterTargetMl'], 'updatedAt' => $r['updatedAt'],
        'meals' => array_map(fn($m) => ['type' => $m['type'], 'name' => $m['name'], 'calories' => $m['calories']], $r['meals']),
        'milestones' => array_map(fn($m) => ['itemKey' => $m['itemKey'], 'label' => $m['label']], $r['milestones'])
    ]];
}, ['err' => 'Could not load the assigned plan']);

route('GET', '/clients/:id/assigned-days', function ($p) {
    $rows = find_all('regimens', ['userId' => js_int($p['id'])], [['day', 'ASC']]);
    $days = array_map(fn($r) => ['day' => $r['day'], 'isFullDayFast' => $r['isFullDayFast'], 'focus' => $r['focus'], 'updatedAt' => $r['updatedAt']], $rows);
    $client = find_pk('users', $p['id']);
    return ['days' => $days, 'currentDay' => $client ? current_challenge_day($client) : 0, 'challengeLengthDays' => $client ? $client['challengeLengthDays'] : 55];
});

route('GET', '/default-day-template', function () {
    return ['template' => settings_get_or_create()['defaultDayTemplate'] ?: null];
});

route('PUT', '/default-day-template', function () {
    $s = settings_get_or_create();
    $meals = in_body('meals'); $ms = in_body('milestones');
    $tpl = [
        'startHour' => in_body('startHour'), 'endHour' => in_body('endHour'),
        'isFullDayFast' => truthy(in_body('isFullDayFast')), 'focus' => truthy(in_body('focus')) ? in_body('focus') : '',
        'waterTargetMl' => truthy(in_body('waterTargetMl')) ? in_body('waterTargetMl') : 3000,
        'meals' => is_array($meals) ? $meals : [], 'milestones' => is_array($ms) ? $ms : [],
        'savedAt' => gmdate('Y-m-d\TH:i:s.') . sprintf('%03d', (int)(fmod(microtime(true), 1) * 1000)) . 'Z'
    ];
    $s = save('settings', $s, ['defaultDayTemplate' => $tpl]);
    return ['template' => $s['defaultDayTemplate']];
}, ['err' => 'Could not save default day']);

route('GET', '/clients/:id/program-guide', function ($p) {
    $c = find_client($p['id']);
    $byDay = [];
    foreach (find_all('regimens', ['userId' => $c['id']], [['day', 'ASC']]) as $r) $byDay[$r['day']] = $r;
    $days = [];
    for ($d = 1; $d <= $c['challengeLengthDays']; $d++) {
        $r = $byDay[$d] ?? null;
        $days[] = [
            'day' => $d, 'phase' => $r ? $r['phase'] : '', 'focus' => $r ? $r['focus'] : '', 'assigned' => (bool)$r,
            'startHour' => $r ? $r['startHour'] : 9, 'endHour' => $r ? $r['endHour'] : 17, 'isFullDayFast' => $r ? $r['isFullDayFast'] : false
        ];
    }
    return ['days' => $days, 'currentDay' => current_challenge_day($c)];
});

/** Regimen.findOrCreate({ where: { userId, day }, defaults }) */
function regimen_find_or_create($userId, $day, $defaults) {
    $r = find_one('regimens', ['userId' => $userId, 'day' => $day]);
    if ($r) return [$r, false];
    try {
        return [create('regimens', array_merge($defaults, ['userId' => $userId, 'day' => $day])), true];
    } catch (PDOException $e) {
        $r = find_one('regimens', ['userId' => $userId, 'day' => $day]);
        if ($r) return [$r, false];
        throw $e;
    }
}

route('PATCH', '/clients/:id/regimen/:day/focus', function ($p) {
    $c = find_client($p['id']);
    $day = js_int($p['day']);
    if (!$day || $day < 1) respond(400, ['error' => 'day must be 1 or higher']);
    if ($day > $c['challengeLengthDays']) $c = save('users', $c, ['challengeLengthDays' => $day]);
    [$r] = regimen_find_or_create($c['id'], $day, ['startHour' => 9, 'endHour' => 17]);
    $ch = [];
    if (is_string(in_body('focus'))) $ch['focus'] = in_body('focus');
    if (is_string(in_body('phase'))) $ch['phase'] = in_body('phase');
    if (is_bool(in_body('isFullDayFast'))) $ch['isFullDayFast'] = in_body('isFullDayFast');
    if (is_int(in_body('startHour')) || is_float(in_body('startHour'))) $ch['startHour'] = in_body('startHour');
    if (is_int(in_body('endHour')) || is_float(in_body('endHour'))) $ch['endHour'] = in_body('endHour');
    $r = save('regimens', $r, $ch);
    return ['day' => $r['day'], 'focus' => $r['focus'], 'phase' => $r['phase'], 'startHour' => $r['startHour'], 'endHour' => $r['endHour'], 'isFullDayFast' => $r['isFullDayFast']];
}, ['err' => 'Could not save day info']);

route('PATCH', '/clients/:id', function ($p) {
    $c = find_client($p['id']);
    $ch = [];
    foreach (['challengeLengthDays', 'heightCm', 'age', 'gender', 'timezone'] as $f) {
        $v = in_body($f);
        if (has_body($f) && $v !== null && $v !== '') $ch[$f] = $v;
    }
    if (truthy(in_body('challengeStartDate'))) $ch['challengeStartDate'] = in_body('challengeStartDate');
    return ['client' => safe_user(save('users', $c, $ch))];
}, ['err' => 'Could not update client']);

route('POST', '/clients/:id/set-day', function ($p) {
    $c = find_client($p['id']);
    if ($c['planMode'] !== 'protocol') respond(400, ['error' => 'This client is on the Fasting Tracker plan, which has no day count.']);
    $day = js_int(in_body('day'));
    if (!$day || $day < 1) respond(400, ['error' => 'day must be 1 or higher']);
    $ch = [];
    if ($day > $c['challengeLengthDays']) $ch['challengeLengthDays'] = $day;
    $today = truthy(in_body('today')) ? in_body('today') : today_local();
    $ch['challengeStartDate'] = add_days($today, -(($day - 1) + ($c['pausedDays'] ?: 0)));
    $c = save('users', $c, $ch);
    return ['client' => safe_user($c), 'day' => current_challenge_day($c)];
}, ['err' => "Could not change the client's day"]);

route('POST', '/clients/:id/program-guide/seed-defaults', function ($p) {
    $c = find_client($p['id']);
    if ($c['planMode'] !== 'protocol') respond(400, ['error' => 'This client is on the Fasting Tracker plan and has no Program Guide.']);
    $protocolDays = protocol_days_all_or_seed();
    $s = settings_get_or_create();
    $phaseGoals = (array)($s['protocolPhaseGoals'] ?: protocol_data()->PHASE_GOALS);
    $textFor = function ($d) use ($phaseGoals) {
        $goal = $phaseGoals[$d['phase']] ?? null;
        return $goal ? "{$d['focus']}\n\n{$d['phase']} goal: $goal" : $d['focus'];
    };
    $overwrite = truthy(in_body('overwrite'));
    $maxDay = max($c['challengeLengthDays'], $protocolDays[count($protocolDays) - 1]['day']);
    if ($maxDay > $c['challengeLengthDays']) $c = save('users', $c, ['challengeLengthDays' => $maxDay]);

    $seeded = 0; $skipped = 0;
    foreach ($protocolDays as $d) {
        [$r, $created] = regimen_find_or_create($c['id'], $d['day'], [
            'phase' => $d['phase'], 'startHour' => $d['startHour'], 'endHour' => $d['endHour'], 'isFullDayFast' => $d['isFullDayFast'],
            'protocolType' => $d['protocolType'], 'waterTargetMl' => $d['waterTargetMl'], 'focus' => $textFor($d)
        ]);
        if (!$created) {
            if (!$overwrite && $r['focus'] && trim($r['focus']) !== '') { $skipped++; continue; }
            $ch = ['focus' => $textFor($d)];
            if (!$r['phase']) $ch['phase'] = $d['phase'];
            save('regimens', $r, $ch);
        }
        $seeded++;
    }
    return ['seeded' => $seeded, 'skipped' => $skipped, 'total' => count($protocolDays)];
}, ['err' => 'Could not seed the program guide']);

function write_regimen($userId, $b) {
    [$r] = regimen_find_or_create($userId, $b['day'], ['startHour' => 9, 'endHour' => 17]);
    $full = truthy($b['isFullDayFast'] ?? null);
    $ch = [
        'startHour' => $full ? ($b['startHour'] ?? $r['startHour']) : ($b['startHour'] ?? null),
        'endHour' => $full ? ($b['endHour'] ?? $r['endHour']) : ($b['endHour'] ?? null),
        'isFullDayFast' => $full,
        'protocolType' => truthy($b['protocolType'] ?? null) ? $b['protocolType'] : 'eating_window',
        'phase' => truthy($b['phase'] ?? null) ? $b['phase'] : '',
        'focus' => truthy($b['focus'] ?? null) ? $b['focus'] : '',
        'waterTargetMl' => truthy($b['waterTargetMl'] ?? null) ? $b['waterTargetMl'] : 3000
    ];
    if ($ch['startHour'] === null || $ch['endHour'] === null) throw new Exception('notNull Violation: Regimen.startHour/endHour cannot be null');
    $r = save('regimens', $r, $ch);
    destroy('regimen_meals', ['regimenId' => $r['id']]);
    destroy('regimen_milestones', ['regimenId' => $r['id']]);
    foreach ((is_array($b['meals'] ?? null) ? $b['meals'] : []) as $m) create('regimen_meals', array_merge((array)$m, ['regimenId' => $r['id']]));
    foreach ((is_array($b['milestones'] ?? null) ? $b['milestones'] : []) as $m) create('regimen_milestones', array_merge((array)$m, ['regimenId' => $r['id']]));
    return $r;
}

route('POST', '/clients/:id/assign-plan', function ($p) {
    $c = find_client($p['id']);
    if ($c['planMode'] !== 'protocol') respond(400, ['error' => 'This client is on the Fasting Tracker plan and has no coach-assigned regimen.']);
    $start = js_int(in_body('day'));
    if (!$start || $start < 1) respond(400, ['error' => 'day must be 1 or higher']);
    $span = max(1, min(90, js_int(in_body('days')) ?: 1));
    $end = $start + $span - 1;
    if ($end > $c['challengeLengthDays']) $c = save('users', $c, ['challengeLengthDays' => $end]);
    $regimen = null; $days = [];
    db()->beginTransaction();
    try {
        for ($d = $start; $d <= $end; $d++) { $regimen = write_regimen($c['id'], array_merge(body(), ['day' => $d])); $days[] = $d; }
        db()->commit();
    } catch (Throwable $e) { db()->rollBack(); throw $e; }
    return ['regimen' => $regimen, 'days' => $days, 'challengeLengthDays' => $c['challengeLengthDays']];
}, ['err' => 'Could not assign plan']);

route('POST', '/assign-plan/apply-all', function () {
    $start = js_int(in_body('day'));
    if (!$start || $start < 1) respond(400, ['error' => 'day must be 1 or higher']);
    $span = max(1, min(90, js_int(in_body('days')) ?: 1));
    $end = $start + $span - 1;
    $clients = find_all('users', ['role' => 'client', 'planMode' => 'protocol', 'status' => 'active']);
    db()->beginTransaction();
    try {
        foreach ($clients as $c) {
            if ($end > $c['challengeLengthDays']) save('users', $c, ['challengeLengthDays' => $end]);
            for ($d = $start; $d <= $end; $d++) write_regimen($c['id'], array_merge(body(), ['day' => $d]));
        }
        db()->commit();
    } catch (Throwable $e) { db()->rollBack(); throw $e; }
    return ['applied' => count($clients), 'days' => $end - $start + 1];
}, ['err' => 'Could not apply plan to cohort']);

/* ---------------- Payments ---------------- */
function with_user($rows) {
    foreach ($rows as &$r) {
        $u = find_pk('users', $r['userId']);
        $r['User'] = $u ? ['id' => $u['id'], 'name' => $u['name'], 'email' => $u['email']] : null;
    }
    return $rows;
}

route('GET', '/payments', function () {
    $s = qparam('status');
    return ['payments' => with_user(find_all('payments', truthy($s) ? ['status' => $s] : [], [['createdAt', 'DESC']]))];
});

route('POST', '/payments/:id/approve', function ($p) {
    $payment = find_pk('payments', $p['id']);
    if (!$payment) respond(404, ['error' => 'Payment not found']);
    $client = find_pk('users', $payment['userId']);
    $plan = find_one('plans', ['key' => $payment['tier']]);
    $payment = save('payments', $payment, ['status' => 'approved', 'reviewedBy' => me()['id'], 'reviewedAt' => now_db()]);

    $mode = $plan ? $plan['mode'] : 'protocol';
    $ch = [];
    if (has_protocol_mode($client)) $ch['hasProtocolAccess'] = true;
    if (has_tracker_mode($client)) $ch['hasTrackerAccess'] = true;
    $ch['status'] = 'active';
    $ch['tier'] = $payment['tier'];
    $ch['planMode'] = $mode;
    if ($mode === 'tracker') {
        $ch['hasTrackerAccess'] = true;
    } else {
        $ch['hasProtocolAccess'] = true;
        $ch['challengeStartDate'] = today_local();
        $ch['challengeLengthDays'] = $plan ? $plan['durationDays'] : 55;
    }
    $ch['hadPaidPlan'] = true;
    $client = save('users', $client, $ch);

    if ($client['referredBy']) {
        if (count_rows('payments', ['userId' => $client['id'], 'status' => 'approved']) === 1) {
            $ref = find_pk('users', $client['referredBy']);
            if ($ref) save('users', $ref, ['walletBalanceInr' => $ref['walletBalanceInr'] + 500]);
        }
    }
    return ['payment' => $payment, 'client' => safe_user($client)];
}, ['err' => 'Could not approve payment']);

route('POST', '/payments/:id/reject', function ($p) {
    $payment = find_pk('payments', $p['id']);
    if (!$payment) respond(404, ['error' => 'Payment not found']);
    return ['payment' => save('payments', $payment, [
        'status' => 'rejected', 'reviewedBy' => me()['id'], 'reviewedAt' => now_db(),
        'adminNote' => truthy(in_body('note')) ? in_body('note') : ''
    ])];
});

/* ---------------- Payouts ---------------- */
route('GET', '/payouts', function () {
    $s = qparam('status');
    return ['payouts' => with_user(find_all('payouts', truthy($s) ? ['status' => $s] : [], [['requestedAt', 'DESC']]))];
});

route('POST', '/payouts/:id/approve', function ($p) {
    $payout = find_pk('payouts', $p['id']);
    if (!$payout) respond(404, ['error' => 'Payout not found']);
    $client = find_pk('users', $payout['userId']);
    if ($client['walletBalanceInr'] < $payout['amountInr']) respond(400, ['error' => 'Insufficient wallet balance']);
    save('users', $client, ['walletBalanceInr' => $client['walletBalanceInr'] - $payout['amountInr']]);
    return ['payout' => save('payouts', $payout, ['status' => 'paid', 'resolvedAt' => now_db(), 'resolvedBy' => me()['id']])];
});

route('POST', '/payouts/:id/reject', function ($p) {
    $payout = find_pk('payouts', $p['id']);
    if (!$payout) respond(404, ['error' => 'Payout not found']);
    return ['payout' => save('payouts', $payout, ['status' => 'rejected', 'resolvedAt' => now_db(), 'resolvedBy' => me()['id']])];
});

/* ---------------- Plans & pricing ---------------- */
route('GET', '/plans', function () {
    plans_seed_if_empty();
    return ['plans' => find_all('plans', [], [['order', 'ASC'], ['priceInr', 'ASC']])];
});

route('POST', '/plans', function () {
    $b = body();
    if (!truthy($b['key'] ?? null) || !truthy($b['name'] ?? null) || !truthy($b['priceInr'] ?? null)) respond(400, ['error' => 'key, name and priceInr are required']);
    $t = fn($k, $d) => truthy($b[$k] ?? null) ? $b[$k] : $d;
    $plan = create('plans', [
        'key' => strtolower(trim($b['key'])), 'name' => $b['name'], 'priceInr' => $b['priceInr'], 'durationDays' => $t('durationDays', 55),
        'tagline' => $t('tagline', ''), 'features' => $t('features', []), 'brochure' => $t('brochure', ''),
        'brochurePdfBase64' => $t('brochurePdfBase64', null), 'brochurePdfName' => $t('brochurePdfName', null),
        'mode' => ($b['mode'] ?? null) === 'tracker' ? 'tracker' : 'protocol', 'order' => $t('order', 0), 'isTrial' => truthy($b['isTrial'] ?? null)
    ]);
    respond(201, ['plan' => $plan]);
}, ['err' => 'Could not create plan']);

route('PUT', '/plans/:id', function ($p) {
    $plan = find_pk('plans', $p['id']);
    if (!$plan) respond(404, ['error' => 'Plan not found']);
    $b = body(); $ch = [];
    foreach (['name', 'priceInr', 'durationDays'] as $f) if (truthy($b[$f] ?? null)) $ch[$f] = $b[$f];
    foreach (['tagline', 'brochure'] as $f) if (is_string($b[$f] ?? null)) $ch[$f] = $b[$f];
    if (is_array($b['features'] ?? null)) $ch['features'] = $b['features'];
    if (is_bool($b['isTrial'] ?? null)) $ch['isTrial'] = $b['isTrial'];
    if (array_key_exists('brochurePdfBase64', $b)) {
        $ch['brochurePdfBase64'] = $b['brochurePdfBase64'];
        $ch['brochurePdfName'] = truthy($b['brochurePdfBase64']) ? (truthy($b['brochurePdfName'] ?? null) ? $b['brochurePdfName'] : $plan['brochurePdfName']) : null;
    }
    if (truthy($b['mode'] ?? null)) $ch['mode'] = $b['mode'] === 'tracker' ? 'tracker' : 'protocol';
    if (is_int($b['order'] ?? null) || is_float($b['order'] ?? null)) $ch['order'] = $b['order'];
    if (is_bool($b['active'] ?? null)) $ch['active'] = $b['active'];
    return ['plan' => save('plans', $plan, $ch)];
}, ['err' => 'Could not update plan']);

route('DELETE', '/plans/:id', function ($p) {
    destroy('plans', ['id' => js_int($p['id'])]);
    return ['ok' => true];
});

/* ---------------- SVR Journal ---------------- */
route('GET', '/journal', function () {
    return ['topics' => find_all('journal_topics', [], [['order', 'ASC'], ['id', 'ASC']])];
});

route('POST', '/journal', function () {
    $b = body();
    if (!truthy($b['title'] ?? null)) respond(400, ['error' => 'title is required']);
    respond(201, ['topic' => create('journal_topics', [
        'title' => $b['title'], 'description' => truthy($b['description'] ?? null) ? $b['description'] : '',
        'youtubeUrl' => truthy($b['youtubeUrl'] ?? null) ? $b['youtubeUrl'] : '', 'order' => truthy($b['order'] ?? null) ? $b['order'] : 0
    ])]);
}, ['err' => 'Could not create journal topic']);

route('PUT', '/journal/:id', function ($p) {
    $t = find_pk('journal_topics', $p['id']);
    if (!$t) respond(404, ['error' => 'Topic not found']);
    $b = body(); $ch = [];
    if (truthy($b['title'] ?? null)) $ch['title'] = $b['title'];
    foreach (['description', 'youtubeUrl'] as $f) if (is_string($b[$f] ?? null)) $ch[$f] = $b[$f];
    if (is_int($b['order'] ?? null) || is_float($b['order'] ?? null)) $ch['order'] = $b['order'];
    if (is_bool($b['active'] ?? null)) $ch['active'] = $b['active'];
    return ['topic' => save('journal_topics', $t, $ch)];
}, ['err' => 'Could not update journal topic']);

route('DELETE', '/journal/:id', function ($p) {
    destroy('journal_topics', ['id' => js_int($p['id'])]);
    return ['ok' => true];
});

/* ---------------- Leaderboard / referrals ---------------- */
route('GET', '/leaderboard', function () {
    return ['leaderboard' => leaderboard_rows(null, true)];
});

route('GET', '/referrals', function () {
    $clients = find_all('users', ['role' => 'client']);
    $byId = [];
    foreach ($clients as $c) $byId[$c['id']] = $c;
    $overview = array_map(function ($c) use ($clients, $byId) {
        return [
            'id' => $c['id'], 'name' => $c['name'], 'email' => $c['email'], 'referralCode' => $c['referralCode'],
            'referredByName' => ($c['referredBy'] && isset($byId[$c['referredBy']])) ? $byId[$c['referredBy']]['name'] : null,
            'referredCount' => count(array_filter($clients, fn($x) => $x['referredBy'] === $c['id'])),
            'walletBalanceInr' => $c['walletBalanceInr']
        ];
    }, $clients);
    return ['overview' => $overview];
});

route('POST', '/referrals/:id/adjust-wallet', function ($p) {
    $c = find_client($p['id']);
    $delta = in_body('deltaInr');
    $c = save('users', $c, ['walletBalanceInr' => max(0, $c['walletBalanceInr'] + (truthy($delta) ? (int)$delta : 0))]);
    return ['client' => safe_user($c), 'note' => truthy(in_body('note')) ? in_body('note') : ''];
});

/* ---------------- Alerts ---------------- */
route('POST', '/alerts', function () {
    $b = body();
    if (!truthy($b['title'] ?? null) || !truthy($b['body'] ?? null)) respond(400, ['error' => 'title and body are required']);
    respond(201, ['alert' => create('alerts', [
        'userId' => truthy($b['userId'] ?? null) ? $b['userId'] : null, 'title' => $b['title'], 'body' => $b['body'],
        'level' => truthy($b['level'] ?? null) ? $b['level'] : 'info', 'createdBy' => me()['id']
    ])]);
}, ['err' => 'Could not send alert']);

route('GET', '/alerts', function () {
    return ['alerts' => find_all('alerts', [], [['createdAt', 'DESC']], 100)];
});

/* ---------------- Chat ---------------- */
route('GET', '/messages/threads', function () {
    $threads = [];
    foreach (find_all('users', ['role' => 'client']) as $c) {
        $last = find_one('messages', ['clientId' => $c['id']], [['createdAt', 'DESC']]);
        if (!$last) continue;
        $threads[] = [
            'clientId' => $c['id'], 'name' => $c['name'],
            'unread' => count_rows('messages', ['clientId' => $c['id'], 'sender' => 'client', 'readByAdmin' => false]),
            'lastMessage' => $last
        ];
    }
    usort($threads, fn($a, $b) => strcmp($b['lastMessage']['createdAt'], $a['lastMessage']['createdAt']));
    return ['threads' => $threads];
});

route('GET', '/messages/:clientId', function ($p) {
    $cid = js_int($p['clientId']);
    $msgs = find_all('messages', ['clientId' => $cid], [['createdAt', 'ASC'], ['id', 'ASC']]);
    q("UPDATE messages SET read_by_admin = 1, updated_at = ? WHERE client_id = ? AND sender = 'client'", [now_db(), $cid]);
    return ['messages' => $msgs];
});

route('POST', '/messages/:clientId', function ($p) {
    $b = in_body('body');
    if (!truthy($b) || !is_string($b) || trim($b) === '') respond(400, ['error' => 'Message body is required']);
    respond(201, ['message' => create('messages', ['clientId' => js_int($p['clientId']), 'sender' => 'admin', 'body' => trim($b)])]);
});

/* ---------------- Contact / settings / branding ---------------- */
route('GET', '/settings', function () {
    return ['settings' => settings_get_or_create()];
});

route('PUT', '/settings', function () {
    $s = settings_get_or_create();
    $ch = [];
    foreach (['coachName', 'phone', 'whatsapp', 'email', 'upiId', 'address', 'supportHours', 'note'] as $f) if (is_string(in_body($f))) $ch[$f] = in_body($f);
    return ['settings' => save('settings', $s, $ch)];
});

route('PUT', '/branding', function () {
    $s = settings_get_or_create();
    $ch = [];
    if (is_string(in_body('siteName'))) $ch['siteName'] = trim(in_body('siteName')) ?: 'FastCoach';
    if (has_body('logoBase64') && (in_body('logoBase64') === null || is_string(in_body('logoBase64')))) $ch['logoBase64'] = in_body('logoBase64') ?: null;
    $s = save('settings', $s, $ch);
    return ['siteName' => $s['siteName'], 'logoBase64' => $s['logoBase64']];
}, ['err' => 'Could not save branding']);
