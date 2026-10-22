<?php
/* routes/client.js — every route requires a signed-in client (group middleware). */

function require_active($opts = []) {
    $u = me();
    if ($u['status'] !== 'active' && $u['status'] !== 'paused') {
        respond(403, ['error' => 'Your account is not active yet. Please complete payment and wait for coach approval.']);
    }
    if (empty($opts['allowExpired']) && has_protocol_mode($u) && is_expired($u)) {
        respond(403, ['error' => 'Your plan has expired. Renew from the Payment page to continue.', 'expired' => true]);
    }
}

function maybe_raise_expiry_alert($user) {
    if (!has_protocol_mode($user) || $user['status'] !== 'active' || !is_expired($user)) return;
    $dueDate = due_date($user);
    $title = "Plan expired — $dueDate";
    if (find_one('alerts', ['userId' => $user['id'], 'title' => $title])) return;
    create('alerts', [
        'userId' => $user['id'], 'title' => $title,
        'body' => "Your plan validity ended on $dueDate. Renew to keep access to your dashboard, coach chat and tracking.",
        'level' => 'important'
    ]);
}

function award_achievement($userId, $type, $title, $description, $hours, $dedupeKey) {
    if (find_one('achievements', ['userId' => $userId, 'type' => $type, 'dedupeKey' => $dedupeKey])) return;
    try {
        create('achievements', ['userId' => $userId, 'type' => $type, 'dedupeKey' => $dedupeKey, 'title' => $title, 'description' => $description, 'hours' => $hours]);
    } catch (PDOException $e) { /* unique index — already awarded concurrently */ }
}

function get_or_create_checklist_log($userId, $day) {
    $log = find_one('checklist_logs', ['userId' => $userId, 'day' => $day]);
    if (!$log) {
        $log = create('checklist_logs', ['userId' => $userId, 'day' => $day]);
        $log['items'] = [];
        $log['waterEntries'] = [];
        return $log;
    }
    $log['items'] = find_all('checklist_items', ['checklistLogId' => $log['id']], [['id', 'ASC']]);
    $log['waterEntries'] = find_all('water_entries', ['checklistLogId' => $log['id']], [['id', 'ASC']]);
    return $log;
}

function sync_checklist_with_regimen($user, $day) {
    $regimen = load_regimen($user['id'], $day);
    $log = get_or_create_checklist_log($user['id'], $day);
    if (!$regimen) return [null, $log];

    $desired = build_checklist_items($regimen);
    $coach = array_filter($log['items'], fn($i) => !$i['custom']);
    $existingByKey = [];
    foreach ($coach as $i) $existingByKey[$i['itemKey']] = $i;
    $desiredKeys = array_flip(array_map(fn($d) => $d['itemKey'], $desired));

    foreach ($coach as $item) if (!isset($desiredKeys[$item['itemKey']])) destroy('checklist_items', ['id' => $item['id']]);
    foreach ($desired as $d) if (!isset($existingByKey[$d['itemKey']])) create('checklist_items', ['checklistLogId' => $log['id']] + $d);

    return [$regimen, get_or_create_checklist_log($user['id'], $day)];
}

function recompute_water($logId) {
    $sum = (int)q('SELECT COALESCE(SUM(ml),0) s FROM water_entries WHERE checklist_log_id = ?', [$logId])->fetch()['s'];
    return $sum;
}

/* ---------------- Dashboard ---------------- */
route('GET', '/dashboard', function () {
    require_active(['allowExpired' => true]);
    $user = me();
    $hasProtocol = has_protocol_mode($user);
    $hasTracker = has_tracker_mode($user);
    $dual = $hasProtocol && $hasTracker;

    $trackerSummary = null;
    if ($hasTracker) {
        $trackerSummary = [
            'running' => find_one('tracker_sessions', ['userId' => $user['id'], 'status' => 'running']),
            'recentSessions' => find_all('tracker_sessions', ['userId' => $user['id']], [['startAt', 'DESC']], 10)
        ];
    }
    if ($hasTracker && !$hasProtocol) {
        return [
            'planMode' => 'tracker', 'dualAccess' => false, 'hasProtocolAccess' => false, 'hasTrackerAccess' => true,
            'user' => safe_user($user), 'running' => $trackerSummary['running'], 'recentSessions' => $trackerSummary['recentSessions']
        ];
    }

    maybe_raise_expiry_alert($user);

    if (is_expired($user)) {
        return [
            'planMode' => 'protocol', 'dualAccess' => $dual, 'hasProtocolAccess' => $hasProtocol, 'hasTrackerAccess' => $hasTracker,
            'expired' => true, 'user' => safe_user($user), 'challengeLengthDays' => $user['challengeLengthDays'],
            'dueDate' => due_date($user), 'daysLeft' => 0
        ];
    }

    $day = current_challenge_day($user);
    [$regimen, $log] = sync_checklist_with_regimen($user, $day);
    $score = apply_scoring($user, $day);
    $user = me();

    return [
        'planMode' => 'protocol', 'dualAccess' => $dual, 'hasProtocolAccess' => $hasProtocol, 'hasTrackerAccess' => $hasTracker,
        'trackerSummary' => $dual ? $trackerSummary : null,
        'expired' => false,
        'user' => safe_user($user),
        'day' => $day,
        'challengeLengthDays' => $user['challengeLengthDays'],
        'daysLeft' => days_left($user),
        'dueDate' => due_date($user),
        'fastingPause' => ['active' => $user['pauseActive'], 'reason' => $user['pauseReason'], 'pausedBy' => $user['pausedBy']],
        'regimen' => $regimen ? [
            'day' => $regimen['day'], 'startHour' => $regimen['startHour'], 'endHour' => $regimen['endHour'],
            'isFullDayFast' => $regimen['isFullDayFast'], 'protocolType' => $regimen['protocolType'],
            'phase' => $regimen['phase'], 'focus' => $regimen['focus'], 'waterTargetMl' => $regimen['waterTargetMl']
        ] : null,
        'checklist' => [
            'meals' => array_values(array_filter($log['items'], fn($i) => $i['kind'] === 'meal')),
            'habits' => array_values(array_filter($log['items'], fn($i) => $i['kind'] === 'habit')),
            'completionPercent' => $score['percent'],
            'scoredDone' => $score['done'],
            'scoredTotal' => $score['total'],
            'threshold' => COMPLETION_THRESHOLD,
            'pointsPerDay' => POINTS_PER_DAY,
            'dayScored' => $score['qualifies'],
            'waterMl' => $log['waterMl'],
            'waterEntries' => $log['waterEntries']
        ]
    ];
});

/* ---------------- Checklist ---------------- */
function owned_item($id) {
    $item = find_pk('checklist_items', $id);
    $log = $item ? find_pk('checklist_logs', $item['checklistLogId']) : null;
    if (!$item || !$log || $log['userId'] !== me()['id']) respond(404, ['error' => 'Item not found']);
    return [$item, $log];
}

route('POST', '/checklist', function () {
    require_active();
    [$item, $log] = owned_item(in_body('itemId'));
    $day = $log['day'];
    $wasScored = $log['streakCounted'];

    $item = save('checklist_items', $item, ['done' => truthy(in_body('done'))]);
    $score = apply_scoring(me(), $day);
    $justCompleted = $score['qualifies'] && !$wasScored;

    if ($justCompleted) {
        $regimen = find_one('regimens', ['userId' => me()['id'], 'day' => $day]);
        if ($regimen && $regimen['isFullDayFast']) {
            award_achievement(me()['id'], 'fast_24h', '24-Hour Fast Completed',
                "Day $day of your programme — a full 24-hour fast.", 24, "protocol-day-$day");
        }
    }
    $item['ChecklistLog'] = $log;
    return [
        'item' => $item,
        'completionPercent' => $score['percent'], 'scoredDone' => $score['done'], 'scoredTotal' => $score['total'],
        'threshold' => COMPLETION_THRESHOLD, 'pointsPerDay' => POINTS_PER_DAY, 'dayScored' => $score['qualifies'],
        'awardedPoints' => $justCompleted,
        'revokedPoints' => !$score['qualifies'] && $wasScored,
        'points' => $score['points'], 'streakCurrent' => $score['streakCurrent'], 'streakBest' => $score['streakBest']
    ];
}, ['err' => 'Could not update checklist item']);

route('POST', '/checklist/items', function () {
    require_active();
    $label = in_body('label');
    if (!truthy($label)) respond(400, ['error' => 'Label is required']);
    $day = current_challenge_day(me());
    $log = get_or_create_checklist_log(me()['id'], $day);
    $item = create('checklist_items', [
        'checklistLogId' => $log['id'], 'itemKey' => 'custom_' . (int)floor(microtime(true) * 1000), 'label' => $label,
        'kind' => in_body('kind') === 'meal' ? 'meal' : 'habit', 'done' => false, 'custom' => true
    ]);
    respond(201, ['item' => $item]);
}, ['err' => 'Could not add item']);

route('PATCH', '/checklist/items/:id', function ($p) {
    require_active();
    [$item, $log] = owned_item($p['id']);
    if (!$item['custom']) respond(403, ['error' => "Coach-assigned items can only be ticked or unticked, not edited."]);
    $label = in_body('label');
    if (is_string($label) && trim($label) !== '') $item = save('checklist_items', $item, ['label' => trim($label)]);
    $item['ChecklistLog'] = $log;
    return ['item' => $item];
}, ['err' => 'Could not update item']);

route('DELETE', '/checklist/items/:id', function ($p) {
    require_active();
    [$item] = owned_item($p['id']);
    if (!$item['custom']) respond(403, ['error' => 'Coach-assigned items cannot be deleted.']);
    destroy('checklist_items', ['id' => $item['id']]);
    return ['ok' => true];
}, ['err' => 'Could not delete item']);

/* ---------------- Water ---------------- */
route('POST', '/water', function () {
    require_active();
    $ml = in_body('ml');
    if (!truthy($ml) || js_float($ml) <= 0) respond(400, ['error' => 'ml must be a positive number']);
    $day = current_challenge_day(me());
    $log = get_or_create_checklist_log(me()['id'], $day);
    create('water_entries', ['checklistLogId' => $log['id'], 'ml' => $ml]);
    $entries = find_all('water_entries', ['checklistLogId' => $log['id']]);
    $total = array_sum(array_map(fn($e) => $e['ml'], $entries));
    save('checklist_logs', $log, ['waterMl' => $total]);
    respond(201, ['waterMl' => $total, 'entries' => $entries]);
}, ['err' => 'Could not log water']);

function owned_water($id) {
    $entry = find_pk('water_entries', $id);
    $log = $entry ? find_pk('checklist_logs', $entry['checklistLogId']) : null;
    if (!$entry || !$log || $log['userId'] !== me()['id']) respond(404, ['error' => 'Entry not found']);
    return [$entry, $log];
}

route('PATCH', '/water/:entryId', function ($p) {
    require_active();
    [$entry, $log] = owned_water($p['entryId']);
    if (truthy(in_body('ml'))) $entry = save('water_entries', $entry, ['ml' => in_body('ml')]);
    $total = recompute_water($log['id']);
    $log = save('checklist_logs', $log, ['waterMl' => $total]);
    $entry['ChecklistLog'] = $log;
    return ['entry' => $entry, 'waterMl' => $total];
}, ['err' => 'Could not update entry']);

route('DELETE', '/water/:entryId', function ($p) {
    require_active();
    [$entry, $log] = owned_water($p['entryId']);
    destroy('water_entries', ['id' => $entry['id']]);
    $total = recompute_water($log['id']);
    save('checklist_logs', $log, ['waterMl' => $total]);
    return ['ok' => true, 'waterMl' => $total];
}, ['err' => 'Could not delete entry']);

/* ---------------- Fasting pause / resume ---------------- */
route('POST', '/fasting/pause', function () {
    require_active();
    $reason = truthy(in_body('reason')) ? in_body('reason') : '';
    $u = save_me(['pauseActive' => true, 'pauseReason' => $reason, 'pauseStartedAt' => now_db(), 'pausedBy' => 'client']);
    return ['fastingPause' => ['active' => true, 'reason' => $u['pauseReason'], 'pausedBy' => 'client'], 'day' => current_challenge_day($u)];
});

route('POST', '/fasting/resume', function () {
    require_active();
    $u = me();
    if ($u['pauseActive'] && $u['pausedBy'] === 'admin') {
        respond(403, ['error' => 'Your coach paused this — only your coach can resume it. Message your coach to ask.']);
    }
    $changes = [];
    $pausedDays = $u['pausedDays'] ?: 0;
    if ($u['pauseActive'] && $u['pauseStartedAt']) {
        $pausedDays += max(0, day_diff(local_date($u['pauseStartedAt']), today_local()));
        $changes['pausedDays'] = $pausedDays;
    }
    $changes += ['pauseActive' => false, 'pauseReason' => '', 'pausedBy' => null, 'pauseLastResumedAt' => now_db()];
    $u = save_me($changes);
    return ['fastingPause' => ['active' => false], 'pausedDays' => $u['pausedDays'], 'day' => current_challenge_day($u)];
});

/* ---------------- Weight / BMI ---------------- */
route('POST', '/weight', function () {
    require_active();
    $weightKg = in_body('weightKg');
    if (!truthy($weightKg)) respond(400, ['error' => 'weightKg is required']);
    $attrs = ['userId' => me()['id'], 'weightKg' => $weightKg];
    if (has_body('note') && in_body('note') !== null) $attrs['note'] = in_body('note');
    $log = create('weight_logs', $attrs);
    respond(201, ['log' => $log, 'bmi' => bmi_of(me(), js_float($weightKg)), 'healthyWeightRange' => healthy_weight_range(me())]);
}, ['err' => 'Could not log weight']);

route('PATCH', '/weight/:logId', function ($p) {
    require_active();
    $log = find_one('weight_logs', ['id' => (int)$p['logId'], 'userId' => me()['id']]);
    if (!$log) respond(404, ['error' => 'Weight entry not found']);
    $ch = [];
    if (truthy(in_body('weightKg'))) $ch['weightKg'] = in_body('weightKg');
    if (is_string(in_body('note'))) $ch['note'] = in_body('note');
    return ['log' => save('weight_logs', $log, $ch)];
}, ['err' => 'Could not update entry']);

route('DELETE', '/weight/:logId', function ($p) {
    require_active();
    $log = find_one('weight_logs', ['id' => (int)$p['logId'], 'userId' => me()['id']]);
    if (!$log) respond(404, ['error' => 'Weight entry not found']);
    destroy('weight_logs', ['id' => $log['id']]);
    return ['ok' => true];
}, ['err' => 'Could not delete entry']);

route('POST', '/profile', function () {
    require_active();
    $ch = [];
    foreach (['heightCm', 'age', 'gender'] as $f) if (truthy(in_body($f))) $ch[$f] = in_body($f);
    $u = save_me($ch);
    return ['user' => safe_user($u)];
}, ['err' => 'Could not save profile']);

route('GET', '/medical', function () {
    require_active();
    $u = me();
    return [
        'medicalConditions' => $u['medicalConditions'] ?: '', 'allergies' => $u['allergies'] ?: '',
        'medications' => $u['medications'] ?: '', 'medicalNotes' => $u['medicalNotes'] ?: ''
    ];
});

route('POST', '/medical', function () {
    require_active();
    $ch = [];
    foreach (['medicalConditions', 'allergies', 'medications', 'medicalNotes'] as $f) if (is_string(in_body($f))) $ch[$f] = in_body($f);
    save_me($ch);
    return ['ok' => true];
}, ['err' => 'Could not save medical details']);

route('GET', '/history', function () {
    require_active();
    $weightLogs = find_all('weight_logs', ['userId' => me()['id']], [['date', 'ASC']]);
    $checklistLogs = find_all('checklist_logs', ['userId' => me()['id']], [['day', 'ASC']]);
    $latest = $weightLogs ? $weightLogs[count($weightLogs) - 1]['weightKg'] : null;
    return ['weightLogs' => $weightLogs, 'checklistLogs' => $checklistLogs, 'bmi' => bmi_of(me(), $latest), 'healthyWeightRange' => healthy_weight_range(me())];
});

route('GET', '/profile-summary', function () {
    require_active();
    $u = me();
    $latest = find_one('weight_logs', ['userId' => $u['id']], [['date', 'DESC']]);
    $w = $latest ? $latest['weightKg'] : null;
    return [
        'name' => $u['name'], 'age' => $u['age'] ?: null, 'gender' => $u['gender'] ?: '', 'heightCm' => $u['heightCm'] ?: null,
        'currentWeightKg' => $w, 'bmi' => bmi_of($u, $w), 'healthyWeightRange' => healthy_weight_range($u),
        'day' => has_protocol_mode($u) ? current_challenge_day($u) : null,
        'challengeLengthDays' => $u['challengeLengthDays'], 'points' => $u['points'], 'streakCurrent' => $u['streakCurrent']
    ];
});

route('GET', '/program-guide', function () {
    require_active();
    $u = me();
    if (!has_protocol_mode($u)) return ['days' => []];
    $byDay = [];
    foreach (find_all('regimens', ['userId' => $u['id']], [['day', 'ASC']]) as $r) $byDay[$r['day']] = $r;
    $days = [];
    for ($d = 1; $d <= $u['challengeLengthDays']; $d++) {
        $r = $byDay[$d] ?? null;
        $days[] = ['day' => $d, 'phase' => $r ? $r['phase'] : '', 'focus' => $r ? $r['focus'] : '', 'assigned' => (bool)$r];
    }
    return ['days' => $days, 'currentDay' => current_challenge_day($u)];
});

/* ---------------- Leaderboard ---------------- */
function leaderboard_rows($statuses, $withStatus) {
    $where = ['role' => 'client', 'planMode' => 'protocol'];
    if ($statuses) $where['status'] = $statuses;
    $rows = find_all('users', $where, [['points', 'DESC']]);
    $keys = ['id', 'name', 'points', 'streakCurrent', 'streakBest'];
    if ($withStatus) $keys[] = 'status';
    return array_map(fn($r) => array_intersect_key($r, array_flip($keys)), $rows);
}
route('GET', '/leaderboard', function () {
    require_active();
    return ['leaderboard' => leaderboard_rows(['active', 'paused'], false)];
});

/* ---------------- Referral ---------------- */
route('GET', '/referral', function () {
    require_active();
    return [
        'referralCode' => me()['referralCode'], 'walletBalanceInr' => me()['walletBalanceInr'],
        'referredCount' => count_rows('users', ['referredBy' => me()['id']])
    ];
});

route('POST', '/payout-request', function () {
    require_active();
    $amount = in_body('amountInr'); $upi = in_body('upiId');
    if (!truthy($amount) || !truthy($upi)) respond(400, ['error' => 'amountInr and upiId are required']);
    if ($amount > me()['walletBalanceInr']) respond(400, ['error' => 'Amount exceeds wallet balance']);
    respond(201, ['payout' => create('payouts', ['userId' => me()['id'], 'amountInr' => $amount, 'upiId' => $upi])]);
}, ['err' => 'Could not request payout']);

/* ---------------- Payments (available before activation) ---------------- */
route('POST', '/payments', function () {
    $tier = in_body('tier'); $utr = in_body('utr');
    if (!truthy($tier) || !truthy($utr)) respond(400, ['error' => 'Plan and UTR are required']);
    $plan = find_one('plans', ['key' => $tier, 'active' => true]);
    if (!$plan) respond(404, ['error' => 'Plan not found']);
    $attrs = ['userId' => me()['id'], 'tier' => $plan['key'], 'planName' => $plan['name'], 'amountInr' => $plan['priceInr'], 'utr' => $utr];
    if (in_body('screenshotBase64') !== null) $attrs['screenshotBase64'] = in_body('screenshotBase64');
    respond(201, ['payment' => create('payments', $attrs)]);
}, ['err' => 'Could not submit payment']);

route('GET', '/payment-status', function () {
    return ['status' => me()['status'], 'lastPayment' => find_one('payments', ['userId' => me()['id']], [['createdAt', 'DESC']])];
});

route('GET', '/plans', function () {
    $plans = find_all('plans', ['active' => true], [['order', 'ASC'], ['priceInr', 'ASC']]);
    if (me()['hadPaidPlan']) $plans = array_values(array_filter($plans, fn($p) => !$p['isTrial'] && $p['priceInr'] > 0));
    return ['plans' => $plans];
});

route('GET', '/journal', function () {
    require_active();
    return ['topics' => find_all('journal_topics', ['active' => true], [['order', 'ASC'], ['id', 'ASC']])];
});

route('GET', '/achievements', function () {
    require_active();
    return ['achievements' => find_all('achievements', ['userId' => me()['id']], [['earnedAt', 'DESC']])];
});

/* ---------------- Older Fasting Tracker endpoints (kept for compatibility) ---------------- */
function session_hours($s) { return (ts($s['endAt']) - ts($s['startAt'])) / 3600; }

route('POST', '/tracker/start', function () {
    require_active();
    if (!has_tracker_mode(me())) respond(403, ['error' => 'Not on the Fasting Tracker plan']);
    if (find_one('tracker_sessions', ['userId' => me()['id'], 'status' => 'running'])) respond(409, ['error' => 'A fast is already running']);
    $target = in_body('targetHours');
    if (!truthy($target) || js_float($target) <= 0) respond(400, ['error' => 'targetHours is required']);
    respond(201, ['session' => create('tracker_sessions', ['userId' => me()['id'], 'startAt' => now_db(), 'targetHours' => $target, 'status' => 'running'])]);
}, ['err' => 'Could not start fast']);

route('POST', '/tracker/stop', function () {
    require_active();
    $s = find_one('tracker_sessions', ['userId' => me()['id'], 'status' => 'running']);
    if (!$s) respond(404, ['error' => 'No fast is running']);
    $end = now_db();
    $actual = (ts($end) - ts($s['startAt'])) / 3600;
    $ch = ['endAt' => $end, 'status' => $actual >= $s['targetHours'] ? 'completed' : 'broken'];
    if (is_string(in_body('note'))) $ch['note'] = in_body('note');
    $s = save('tracker_sessions', $s, $ch);
    if ($s['status'] === 'completed' && $actual >= 24) {
        award_achievement(me()['id'], 'fast_24h', '24-Hour Fast Completed',
            'A self-guided fast of ' . round1($actual) . ' hours.', round1($actual), "tracker-session-{$s['id']}");
    }
    return ['session' => $s];
}, ['err' => 'Could not stop fast']);

route('GET', '/tracker/history', function () {
    require_active();
    return ['sessions' => find_all('tracker_sessions', ['userId' => me()['id']], [['startAt', 'DESC']], 60)];
});

route('PATCH', '/tracker/session/:id', function ($p) {
    require_active();
    $s = find_one('tracker_sessions', ['id' => (int)$p['id'], 'userId' => me()['id']]);
    if (!$s) respond(404, ['error' => 'Fast not found']);
    if ($s['status'] !== 'running') respond(400, ['error' => 'Only a running fast can be edited']);
    $ch = [];
    if (truthy(in_body('startAt'))) $ch['startAt'] = in_body('startAt');
    if (truthy(in_body('targetHours'))) $ch['targetHours'] = in_body('targetHours');
    return ['session' => save('tracker_sessions', $s, $ch)];
}, ['err' => 'Could not update fast']);

/** Consecutive local days (ending today) with a completed fast, plus longest run. */
function legacy_tracker_streaks($completed) {
    $days = [];
    foreach ($completed as $s) $days[local_date($s['startAt'])] = true;
    $current = 0; $cursor = today_local();
    while (isset($days[$cursor])) { $current++; $cursor = add_days($cursor, -1); }
    $sorted = array_keys($days); sort($sorted);
    $longest = 0; $run = 0; $prev = null;
    foreach ($sorted as $d) {
        $run = ($prev && day_diff($prev, $d) === 1) ? $run + 1 : 1;
        $longest = max($longest, $run);
        $prev = $d;
    }
    return [$current, $longest];
}

route('GET', '/tracker/stats', function () {
    require_active();
    $sessions = find_all('tracker_sessions', ['userId' => me()['id'], 'status' => ['completed', 'broken']], [['startAt', 'DESC']]);
    $completed = array_filter($sessions, fn($s) => $s['status'] === 'completed');
    $hours = array_map('session_hours', $sessions);
    $last7 = array_slice($hours, 0, 7);
    [$current, $longest] = legacy_tracker_streaks($completed);
    return [
        'totalFasts' => count($sessions),
        'longestFastHours' => $hours ? round1(max($hours)) : 0,
        'avg7FastHours' => $last7 ? round1(array_sum($last7) / count($last7)) : 0,
        'currentStreak' => $current, 'longestStreak' => $longest
    ];
});

route('POST', '/tracker/water', function () {
    require_active();
    $ml = in_body('ml');
    if (!truthy($ml) || js_float($ml) <= 0) respond(400, ['error' => 'ml must be a positive number']);
    respond(201, ['entry' => create('tracker_water_entries', ['userId' => me()['id'], 'ml' => $ml])]);
}, ['err' => 'Could not log water']);

route('GET', '/tracker/water', function () {
    require_active();
    $sinceLocal = new DateTime(add_days(today_local(), -9) . ' 00:00:00', app_tz());
    $sinceLocal->setTimezone(new DateTimeZone('UTC'));
    $entries = find_all('tracker_water_entries', ['userId' => me()['id']], [['at', 'ASC']], null, ' AND `at` >= ?', [$sinceLocal->format('Y-m-d H:i:s')]);
    $label = fn($ymd) => (new DateTime($ymd . ' 00:00:00'))->format('D M d Y');
    $byDate = [];
    foreach ($entries as $e) { $k = $label(local_date($e['at'])); $byDate[$k] = ($byDate[$k] ?? 0) + $e['ml']; }
    $last7 = [];
    for ($i = 6; $i >= 0; $i--) { $k = $label(add_days(today_local(), -$i)); $last7[] = ['date' => $k, 'ml' => $byDate[$k] ?? 0]; }
    return ['goalMl' => me()['waterGoalMl'], 'todayMl' => $byDate[$label(today_local())] ?? 0, 'last7' => $last7];
});

route('DELETE', '/tracker/water/:id', function ($p) {
    require_active();
    $e = find_one('tracker_water_entries', ['id' => (int)$p['id'], 'userId' => me()['id']]);
    if (!$e) respond(404, ['error' => 'Entry not found']);
    destroy('tracker_water_entries', ['id' => $e['id']]);
    return ['ok' => true];
});

route('POST', '/tracker/water-goal', function () {
    require_active();
    $g = in_body('goalMl');
    if (!truthy($g) || js_float($g) <= 0) respond(400, ['error' => 'goalMl is required']);
    $u = save_me(['waterGoalMl' => $g]);
    return ['goalMl' => $u['waterGoalMl']];
});

/* ---------------- Today-page progress card ---------------- */
route('GET', '/progress', function () {
    require_active();
    $user = me();
    if (has_tracker_mode($user) && !has_protocol_mode($user)) {
        $sessions = find_all('tracker_sessions', ['userId' => $user['id'], 'status' => ['completed', 'broken']]);
        $completed = array_filter($sessions, fn($s) => $s['status'] === 'completed');
        [$current] = legacy_tracker_streaks($completed);
        $hours = array_map('session_hours', $sessions);
        return ['planMode' => 'tracker', 'totalFasts' => count($sessions), 'currentStreak' => $current, 'longestFastHours' => $hours ? round1(max($hours)) : 0];
    }
    $day = current_challenge_day($user);
    $score = apply_scoring($user, $day);
    return [
        'planMode' => 'protocol', 'points' => $score['points'], 'streakCurrent' => $score['streakCurrent'], 'streakBest' => $score['streakBest'],
        'day' => $day, 'challengeLengthDays' => $user['challengeLengthDays'],
        'todayPercent' => $score['percent'], 'todayDone' => $score['done'], 'todayTotal' => $score['total'],
        'todayScored' => $score['qualifies'], 'threshold' => COMPLETION_THRESHOLD, 'pointsPerDay' => POINTS_PER_DAY
    ];
});

/* ---------------- Alerts ---------------- */
route('GET', '/alerts', function () {
    require_active(['allowExpired' => true]);
    $uid = me()['id'];
    $alerts = find_all('alerts', [], [['createdAt', 'DESC']], null, ' AND (`user_id` IS NULL OR `user_id` = ?)', [$uid]);
    $unread = 0;
    foreach ($alerts as &$a) {
        $a['AlertReads'] = find_all('alert_reads', ['alertId' => $a['id'], 'userId' => $uid]);
        if (!$a['AlertReads']) $unread++;
    }
    return ['alerts' => $alerts, 'unread' => $unread];
});

route('POST', '/alerts/:id/read', function ($p) {
    require_active(['allowExpired' => true]);
    if (!find_one('alert_reads', ['alertId' => (int)$p['id'], 'userId' => me()['id']])) {
        create('alert_reads', ['alertId' => (int)$p['id'], 'userId' => me()['id']]);
    }
    return ['ok' => true];
});

/* ---------------- Chat (available before activation) ---------------- */
route('GET', '/messages', function () {
    $msgs = find_all('messages', ['clientId' => me()['id']], [['createdAt', 'ASC'], ['id', 'ASC']]);
    q("UPDATE messages SET read_by_client = 1, updated_at = ? WHERE client_id = ? AND sender = 'admin'", [now_db(), me()['id']]);
    return ['messages' => $msgs];
});

route('POST', '/messages', function () {
    $b = in_body('body');
    if (!truthy($b) || !is_string($b) || trim($b) === '') respond(400, ['error' => 'Message body is required']);
    respond(201, ['message' => create('messages', ['clientId' => me()['id'], 'sender' => 'client', 'body' => trim($b)])]);
});

/* ---------------- Contact us (available before activation) ---------------- */
route('GET', '/contact', function () {
    return ['settings' => settings_get_or_create()];
});
