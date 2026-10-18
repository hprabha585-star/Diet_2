<?php
/* routes/tracker.js — Fasting Tracker API. Calendar-day keys come from the
   browser's own date (?date= / body.date); durations from timestamps. */

function require_tracker() {
    $u = me();
    if ($u['status'] !== 'active' && $u['status'] !== 'paused') {
        respond(403, ['error' => 'Your account is not active yet. Complete payment and wait for coach approval.']);
    }
    if ($u['planMode'] !== 'tracker') {
        respond(403, ['error' => 'The Fasting Tracker is a separate plan. Pick it up from the Payment page to unlock it.']);
    }
}

function hours_between($a, $b) { return (ts($b) - ts($a)) / 3600; }
function hours_since($a) { return (now_ts() - ts($a)) / 3600; }
function local_date_of_req() {
    $d = qparam('date');
    if (truthy($d)) return $d;
    $d = in_body('date');
    if (truthy($d)) return $d;
    return today_local();
}
function hhmm($h) {
    $t = fmod(fmod($h, 24) + 24, 24);
    $hh = (int)floor($t); $mm = jsround(($t - $hh) * 60);
    return sprintf('%02d:%02d', $hh, $mm);
}

/* ---------------- static content ---------------- */
route('GET', '/content', function () {
    $f = fasting_data();
    return [
        'schedules' => $f->SCHEDULES, 'stages' => $f->STAGES, 'education' => $f->EDUCATION, 'tips' => $f->TIPS,
        'tipOfDay' => tip_for_date(local_date_of_req()), 'dailyTasks' => $f->DAILY_TASKS,
        'goalOptions' => $f->GOAL_OPTIONS, 'safety' => $f->SAFETY
    ];
});

route('GET', '/schedules', function () {
    $profile = tracker_profile_for(me()['id']);
    $startHour = qparam('startHour') !== null ? js_float(qparam('startHour')) : $profile['startHour'];
    $out = [];
    foreach (fasting_data()->SCHEDULES as $s) {
        $s = (array)$s;
        $s['suggestedStart'] = hhmm($startHour);
        $s['fastEndsAt'] = hhmm($startHour + $s['fastHours']);
        $s['eatingEndsAt'] = hhmm($startHour + $s['fastHours'] + $s['eatHours']);
        $out[] = $s;
    }
    return ['startHour' => $startHour, 'schedules' => $out, 'selected' => $profile['scheduleKey']];
});

/* ---------------- profile ---------------- */
route('GET', '/profile', function () {
    return ['profile' => tracker_profile_for(me()['id'])];
});

route('PUT', '/profile', function () {
    $profile = tracker_profile_for(me()['id']);
    $fields = ['scheduleKey', 'fastHours', 'eatHours', 'startHour', 'dailyGoalHours', 'waterGoalMl', 'waterUnit', 'calorieGoal',
        'proteinGoalG', 'carbGoalG', 'fatGoalG', 'weeklySchedule', 'schedulePaused', 'reminders', 'goalFocus', 'dismissedTips'];
    $ch = [];
    foreach ($fields as $f) if (has_body($f)) {
        $v = in_body($f);
        // keep {} as an object for the JSON columns
        if (in_array($f, ['weeklySchedule', 'reminders']) && is_array($v) && !array_is_list($v)) $v = json_decode(json_encode($v));
        if (in_array($f, ['weeklySchedule', 'reminders']) && $v === []) $v = new stdClass();
        $ch[$f] = $v;
    }
    $fast = $ch['fastHours'] ?? $profile['fastHours'];
    $eat = $ch['eatHours'] ?? $profile['eatHours'];
    if ($fast + $eat > 24) respond(400, ['error' => 'Fasting hours plus eating hours cannot exceed 24.']);
    $profile = save('tracker_profiles', $profile, $ch);
    if (truthy(in_body('waterGoalMl'))) save_me(['waterGoalMl' => in_body('waterGoalMl')]);
    return ['profile' => $profile];
}, ['err' => 'Could not save settings']);

/* ---------------- live state ---------------- */
function build_state($user, $date) {
    $profile = tracker_profile_for($user['id']);
    $running = find_one('tracker_sessions', ['userId' => $user['id'], 'status' => 'running']);
    $fast = null;
    if ($running) {
        $elapsed = hours_since($running['startAt']);
        $target = $running['targetHours'];
        $stage = stage_for($elapsed);
        $fast = [
            'id' => $running['id'], 'scheduleKey' => $running['scheduleKey'], 'startAt' => $running['startAt'],
            'expectedEndAt' => iso(gmdate('Y-m-d H:i:s', (int)round(ts($running['startAt']) + $target * 3600))),
            'targetHours' => $target, 'eatingHours' => $running['eatingHours'],
            'elapsedHours' => round1($elapsed), 'remainingHours' => round1(max(0, $target - $elapsed)),
            'percent' => max(0, min(100, jsround(($elapsed / $target) * 100))),
            'reachedTarget' => $elapsed >= $target,
            'stage' => ['key' => $stage->key, 'name' => $stage->name, 'short' => $stage->short, 'detail' => $stage->detail, 'from' => $stage->from, 'to' => $stage->to]
        ];
    }
    $eatingRow = find_all('tracker_sessions', ['userId' => $user['id']], [['eatingStartedAt', 'DESC']], 1,
        ' AND `eating_ends_at` > ? AND `eating_started_at` IS NOT NULL', [now_db()]);
    $eating = null;
    if ($eatingRow) {
        $e = $eatingRow[0];
        $total = hours_between($e['eatingStartedAt'], $e['eatingEndsAt']);
        $done = hours_since($e['eatingStartedAt']);
        $eating = [
            'startAt' => $e['eatingStartedAt'], 'endsAt' => $e['eatingEndsAt'],
            'remainingHours' => round1(max(0, $total - $done)),
            'percent' => max(0, min(100, jsround(($done / $total) * 100)))
        ];
    }
    $goalHours = 0;
    foreach (find_all('tracker_sessions', ['userId' => $user['id'], 'localDate' => $date]) as $s) {
        $goalHours += $s['status'] === 'running' ? hours_since($s['startAt']) : ($s['endAt'] ? hours_between($s['startAt'], $s['endAt']) : 0);
    }
    $rest = find_one('rest_days', ['userId' => $user['id'], 'date' => $date]);
    return [
        'profile' => $profile, 'fast' => $fast, 'eating' => $eating, 'restDay' => (bool)$rest,
        'dailyGoal' => [
            'targetHours' => $profile['dailyGoalHours'], 'completedHours' => round1($goalHours),
            'percent' => min(100, jsround(($goalHours / $profile['dailyGoalHours']) * 100))
        ]
    ];
}

route('GET', '/state', function () {
    return build_state(me(), local_date_of_req());
}, ['err' => 'Could not load tracker state']);

/* ---------------- start / end / cancel ---------------- */
route('POST', '/start', function () {
    $existing = find_one('tracker_sessions', ['userId' => me()['id'], 'status' => 'running']);
    if ($existing) respond(409, ['error' => 'You already have an active fast.', 'code' => 'ACTIVE_FAST', 'session' => $existing]);
    $profile = tracker_profile_for(me()['id']);
    $scheduleKey = truthy(in_body('scheduleKey')) ? in_body('scheduleKey') : $profile['scheduleKey'];
    $preset = null;
    foreach (fasting_data()->SCHEDULES as $s) if ($s->key === $scheduleKey) $preset = $s;
    $target = js_float(in_body('targetHours')) ?: ($preset ? $preset->fastHours : $profile['fastHours']);
    $eatH = js_float(in_body('eatingHours')) ?: ($preset ? $preset->eatHours : $profile['eatHours']);
    if (!$target || $target <= 0 || $target > 72) respond(400, ['error' => 'Target hours must be between 1 and 72.']);

    if (truthy(in_body('startAt'))) {
        $startAt = to_db_datetime(in_body('startAt'));
        if (!$startAt) respond(400, ['error' => 'Invalid start time']);
    } else $startAt = now_db();
    if (ts($startAt) > time() + 60) respond(400, ['error' => 'A fast cannot start in the future.']);

    $session = create('tracker_sessions', [
        'userId' => me()['id'], 'startAt' => $startAt, 'targetHours' => $target, 'eatingHours' => $eatH, 'scheduleKey' => $scheduleKey,
        'status' => 'running', 'localDate' => truthy(in_body('date')) ? in_body('date') : local_date($startAt)
    ]);
    respond(201, ['session' => $session, 'state' => build_state(me(), $session['localDate'])]);
}, ['err' => 'Could not start fast']);

route('PATCH', '/session/:id', function ($p) {
    $s = find_one('tracker_sessions', ['id' => js_int($p['id']), 'userId' => me()['id']]);
    if (!$s) respond(404, ['error' => 'Fast not found']);
    if ($s['status'] !== 'running') respond(400, ['error' => 'Only a running fast can be edited.']);
    $ch = [];
    if (truthy(in_body('startAt'))) {
        $d = to_db_datetime(in_body('startAt'));
        if (!$d || ts($d) > time() + 60) respond(400, ['error' => 'Invalid start time']);
        $ch['startAt'] = $d;
        $ch['localDate'] = truthy(in_body('date')) ? in_body('date') : local_date($d);
    }
    if (truthy(in_body('targetHours'))) $ch['targetHours'] = js_float(in_body('targetHours'));
    if (truthy(in_body('eatingHours'))) $ch['eatingHours'] = js_float(in_body('eatingHours'));
    $s = save('tracker_sessions', $s, $ch);
    return ['session' => $s, 'state' => build_state(me(), local_date_of_req())];
}, ['err' => 'Could not update fast']);

route('POST', '/end', function () {
    $s = find_one('tracker_sessions', ['userId' => me()['id'], 'status' => 'running']);
    if (!$s) respond(404, ['error' => 'No fast is running.']);
    $end = now_db();
    $actual = hours_between($s['startAt'], $end);
    $ch = ['endAt' => $end, 'status' => $actual >= $s['targetHours'] ? 'completed' : 'ended_early'];
    if (is_string(in_body('note'))) $ch['note'] = in_body('note');
    if (truthy(in_body('startEatingWindow'))) {
        $ch['eatingStartedAt'] = $end;
        $ch['eatingEndsAt'] = gmdate('Y-m-d H:i:s', (int)round(ts($end) + ($s['eatingHours'] ?: 8) * 3600));
    }
    $s = save('tracker_sessions', $s, $ch);
    return [
        'session' => $s,
        'summary' => ['targetHours' => $s['targetHours'], 'actualHours' => round1($actual), 'percent' => jsround(($actual / $s['targetHours']) * 100), 'status' => $s['status']],
        'state' => build_state(me(), local_date_of_req())
    ];
}, ['err' => 'Could not end fast']);

route('POST', '/cancel', function () {
    $s = find_one('tracker_sessions', ['userId' => me()['id'], 'status' => 'running']);
    if (!$s) respond(404, ['error' => 'No fast is running.']);
    $s = save('tracker_sessions', $s, ['endAt' => now_db(), 'status' => 'cancelled']);
    return ['session' => $s, 'state' => build_state(me(), local_date_of_req())];
}, ['err' => 'Could not cancel fast']);

route('POST', '/eating/start', function () {
    $s = find_one('tracker_sessions', ['userId' => me()['id'], 'status' => ['completed', 'ended_early', 'broken']], [['endAt', 'DESC']]);
    if (!$s) respond(404, ['error' => 'No finished fast to open an eating window for.']);
    $hours = js_float(in_body('eatingHours')) ?: ($s['eatingHours'] ?: 8);
    save('tracker_sessions', $s, ['eatingStartedAt' => now_db(), 'eatingEndsAt' => gmdate('Y-m-d H:i:s', (int)round(time() + $hours * 3600))]);
    return ['state' => build_state(me(), local_date_of_req())];
}, ['err' => 'Could not start eating window']);

/* ---------------- history ---------------- */
route('GET', '/history', function () {
    $limit = min(js_int(qparam('limit')) ?: 60, 200);
    $rows = find_all('tracker_sessions', ['userId' => me()['id']], [['startAt', 'DESC']], $limit, " AND `status` <> 'running'");
    $sessions = array_map(function ($s) {
        $actual = $s['endAt'] ? hours_between($s['startAt'], $s['endAt']) : 0;
        return [
            'id' => $s['id'], 'date' => $s['localDate'] ?: local_date($s['startAt']), 'startAt' => $s['startAt'], 'endAt' => $s['endAt'],
            'scheduleKey' => $s['scheduleKey'], 'targetHours' => $s['targetHours'], 'actualHours' => round1($actual),
            'percent' => $s['targetHours'] ? jsround(($actual / $s['targetHours']) * 100) : 0,
            'status' => $s['status'] === 'broken' ? 'ended_early' : $s['status'], 'note' => $s['note']
        ];
    }, $rows);
    return ['sessions' => $sessions];
});

route('DELETE', '/history/:id', function ($p) {
    $row = find_one('tracker_sessions', ['id' => js_int($p['id']), 'userId' => me()['id']]);
    if (!$row) respond(404, ['error' => 'Not found']);
    destroy('tracker_sessions', ['id' => $row['id']]);
    return ['ok' => true];
});

/* ---------------- statistics ---------------- */
function streaks_from($fasted, $rest, $today) {
    $current = 0;
    $cursor = $today;
    if (!isset($fasted[$today])) $cursor = add_days($cursor, -1);
    for ($i = 0; $i < 400; $i++) {
        if (isset($fasted[$cursor])) $current++;
        elseif (!isset($rest[$cursor])) break;
        $cursor = add_days($cursor, -1);
    }
    $all = array_keys($fasted); sort($all);
    $longest = 0; $run = 0; $prev = null;
    foreach ($all as $key) {
        if ($prev) {
            $gap = day_diff($prev, $key);
            $bridged = $gap === 1;
            if (!$bridged && $gap > 1) {
                $bridged = true;
                $c = $prev;
                for ($i = 1; $i < $gap; $i++) { $c = add_days($c, 1); if (!isset($rest[$c])) { $bridged = false; break; } }
            }
            $run = $bridged ? $run + 1 : 1;
        } else $run = 1;
        $longest = max($longest, $run);
        $prev = $key;
    }
    return ['current' => $current, 'longest' => $longest];
}
function session_date($s) { return $s['localDate'] ?: local_date($s['startAt']); }

route('GET', '/stats', function () {
    $today = local_date_of_req();
    $range = truthy(qparam('range')) ? qparam('range') : 'all';
    $all = find_all('tracker_sessions', ['userId' => me()['id']], [['startAt', 'ASC']], null, " AND `status` <> 'running'");
    $rests = find_all('rest_days', ['userId' => me()['id']]);

    if ($range === 'week') $from = add_days($today, -6);
    elseif ($range === 'month') $from = add_days($today, -29);
    else $from = (new DateTime($today))->modify('-50 years')->format('Y-m-d');

    $inRange = array_values(array_filter($all, fn($s) => session_date($s) >= $from));
    $counted = array_values(array_filter($inRange, fn($s) => $s['status'] !== 'cancelled' && $s['endAt']));
    $durations = array_map(fn($s) => hours_between($s['startAt'], $s['endAt']), $counted);
    $completed = array_filter($counted, fn($s) => $s['status'] === 'completed');
    $total = array_sum($durations);

    $fasted = [];
    foreach ($all as $s) if ($s['status'] === 'completed') $fasted[session_date($s)] = true;
    $restSet = [];
    foreach ($rests as $r) $restSet[$r['date']] = true;
    $streak = streaks_from($fasted, $restSet, $today);
    $wk = add_days($today, -6); $mo = add_days($today, -29);

    return [
        'range' => $range,
        'totalFasts' => count($inRange),
        'completedFasts' => count($completed),
        'cancelledFasts' => count(array_filter($inRange, fn($s) => $s['status'] === 'cancelled')),
        'averageHours' => $durations ? round1($total / count($durations)) : 0,
        'longestHours' => $durations ? round1(max($durations)) : 0,
        'shortestHours' => $durations ? round1(min($durations)) : 0,
        'completionRate' => $counted ? jsround((count($completed) / count($counted)) * 100) : 0,
        'totalHours' => round1($total),
        'currentStreak' => $streak['current'], 'longestStreak' => $streak['longest'],
        'daysThisWeek' => count(array_filter(array_keys($fasted), fn($d) => $d >= $wk)),
        'daysThisMonth' => count(array_filter(array_keys($fasted), fn($d) => $d >= $mo)),
        'restDays' => count(array_filter(array_keys($restSet), fn($d) => $d >= $from))
    ];
}, ['err' => 'Could not load statistics']);

route('GET', '/weekly', function () {
    $today = local_date_of_req();
    $profile = tracker_profile_for(me()['id']);
    $start = add_days($today, -6);
    $rows = find_all('tracker_sessions', ['userId' => me()['id']], null, null, " AND `local_date` >= ? AND `status` <> 'cancelled'", [$start]);
    $rests = find_all('rest_days', ['userId' => me()['id']], null, null, ' AND `date` >= ?', [$start]);
    $restSet = [];
    foreach ($rests as $r) $restSet[$r['date']] = true;
    $days = [];
    for ($i = 0; $i < 7; $i++) {
        $key = add_days($start, $i);
        $h = 0;
        foreach ($rows as $s) if (session_date($s) === $key) $h += $s['endAt'] ? hours_between($s['startAt'], $s['endAt']) : hours_since($s['startAt']);
        $days[] = ['date' => $key, 'hours' => round1($h), 'restDay' => isset($restSet[$key])];
    }
    $active = array_values(array_filter($days, fn($d) => $d['hours'] > 0));
    return [
        'days' => $days, 'goalHours' => $profile['dailyGoalHours'],
        'weeklyTargetHours' => round1($profile['dailyGoalHours'] * 7),
        'completedHours' => round1(array_sum(array_column($days, 'hours'))),
        'averageHours' => $active ? round1(array_sum(array_column($active, 'hours')) / count($active)) : 0,
        'completedFasts' => count($active)
    ];
});

/* ---------------- calendar ---------------- */
route('GET', '/calendar', function () {
    $month = truthy(qparam('month')) ? qparam('month') : substr(local_date_of_req(), 0, 7);
    $first = "$month-01";
    $last = (new DateTime($first))->modify('last day of this month')->format('Y-m-d');
    $sessions = find_all('tracker_sessions', ['userId' => me()['id']], [['startAt', 'ASC']], null, ' AND `local_date` BETWEEN ? AND ?', [$first, $last]);
    $rests = find_all('rest_days', ['userId' => me()['id']], null, null, ' AND `date` BETWEEN ? AND ?', [$first, $last]);

    $byDate = [];
    foreach ($sessions as $s) {
        $key = session_date($s);
        $h = $s['endAt'] ? hours_between($s['startAt'], $s['endAt']) : hours_since($s['startAt']);
        if (!isset($byDate[$key])) $byDate[$key] = ['date' => $key, 'hours' => 0, 'sessions' => [], 'status' => 'none'];
        $byDate[$key]['hours'] = round1($byDate[$key]['hours'] + $h);
        $byDate[$key]['sessions'][] = [
            'id' => $s['id'], 'startAt' => $s['startAt'], 'endAt' => $s['endAt'], 'targetHours' => $s['targetHours'],
            'actualHours' => round1($h), 'status' => $s['status'] === 'broken' ? 'ended_early' : $s['status']
        ];
    }
    foreach ($byDate as $k => $d) {
        $st = array_column($d['sessions'], 'status');
        $byDate[$k]['status'] = in_array('running', $st) ? 'active' : (in_array('completed', $st) ? 'completed' : (in_array('ended_early', $st) ? 'partial' : 'cancelled'));
    }
    foreach ($rests as $r) {
        $key = $r['date'];
        if (!isset($byDate[$key])) $byDate[$key] = ['date' => $key, 'hours' => 0, 'sessions' => [], 'status' => 'rest'];
        else $byDate[$key]['restDay'] = true;
    }
    ksort($byDate);
    return ['month' => $month, 'days' => array_values($byDate)];
});

route('POST', '/rest-day', function () {
    $date = in_body('date');
    if (!truthy($date)) respond(400, ['error' => 'date is required']);
    $existing = find_one('rest_days', ['userId' => me()['id'], 'date' => $date]);
    if ($existing) { destroy('rest_days', ['id' => $existing['id']]); return ['date' => $date, 'restDay' => false]; }
    $attrs = ['userId' => me()['id'], 'date' => $date];
    if (in_body('note') !== null) $attrs['note'] = in_body('note');
    create('rest_days', $attrs);
    return ['date' => $date, 'restDay' => true];
});

/* ---------------- nutrition ---------------- */
route('GET', '/nutrition', function () {
    $date = local_date_of_req();
    $profile = tracker_profile_for(me()['id']);
    $meals = find_all('meal_entries', ['userId' => me()['id'], 'date' => $date], [['createdAt', 'ASC'], ['id', 'ASC']]);
    $sum = fn($f) => jsround(array_sum(array_map(fn($m) => $m[$f] ?: 0, $meals)) * 10) / 10;
    $byCategory = [];
    foreach (['breakfast', 'lunch', 'dinner', 'snack'] as $c) {
        $items = array_values(array_filter($meals, fn($m) => $m['category'] === $c));
        $byCategory[$c] = ['items' => $items, 'calories' => jsround(array_sum(array_map(fn($m) => $m['calories'] ?: 0, $items)))];
    }
    return [
        'date' => $date, 'meals' => $meals, 'byCategory' => $byCategory,
        'totals' => ['calories' => $sum('calories'), 'proteinG' => $sum('proteinG'), 'carbsG' => $sum('carbsG'), 'fatG' => $sum('fatG')],
        'goals' => ['calories' => $profile['calorieGoal'], 'proteinG' => $profile['proteinGoalG'], 'carbsG' => $profile['carbGoalG'], 'fatG' => $profile['fatGoalG']]
    ];
});

route('POST', '/meals', function () {
    $date = in_body('date'); $category = in_body('category'); $name = in_body('name');
    if (!truthy($date) || !truthy($category) || !truthy($name)) respond(400, ['error' => 'date, category and name are required']);
    $meal = create('meal_entries', [
        'userId' => me()['id'], 'date' => $date, 'category' => $category, 'name' => trim((string)$name),
        'quantity' => truthy(in_body('quantity')) ? in_body('quantity') : null,
        'calories' => js_float(in_body('calories')) ?: 0, 'proteinG' => js_float(in_body('proteinG')) ?: 0,
        'carbsG' => js_float(in_body('carbsG')) ?: 0, 'fatG' => js_float(in_body('fatG')) ?: 0,
        'notes' => truthy(in_body('notes')) ? in_body('notes') : null
    ]);
    respond(201, ['meal' => $meal]);
}, ['err' => 'Could not log meal']);

route('PATCH', '/meals/:id', function ($p) {
    $m = find_one('meal_entries', ['id' => js_int($p['id']), 'userId' => me()['id']]);
    if (!$m) respond(404, ['error' => 'Meal not found']);
    $ch = [];
    foreach (['category', 'name', 'quantity', 'calories', 'proteinG', 'carbsG', 'fatG', 'notes'] as $f) if (has_body($f)) $ch[$f] = in_body($f);
    return ['meal' => save('meal_entries', $m, $ch)];
});

route('DELETE', '/meals/:id', function ($p) {
    $m = find_one('meal_entries', ['id' => js_int($p['id']), 'userId' => me()['id']]);
    if (!$m) respond(404, ['error' => 'Meal not found']);
    destroy('meal_entries', ['id' => $m['id']]);
    return ['ok' => true];
});

/* ---------------- hydration ---------------- */
route('GET', '/water', function () {
    $date = local_date_of_req();
    $profile = tracker_profile_for(me()['id']);
    $start = add_days($date, -29);
    $entries = find_all('tracker_water_entries', ['userId' => me()['id']], [['at', 'ASC']], null, ' AND `local_date` >= ?', [$start]);
    $byDate = [];
    foreach ($entries as $e) { $k = $e['localDate'] ?: local_date($e['at']); $byDate[$k] = ($byDate[$k] ?? 0) + $e['ml']; }
    $last7 = [];
    for ($i = 6; $i >= 0; $i--) { $k = add_days($date, -$i); $last7[] = ['date' => $k, 'ml' => $byDate[$k] ?? 0]; }
    $bestKey = null;
    if ($byDate) { $sorted = $byDate; arsort($sorted, SORT_NUMERIC); $bestKey = array_key_first($sorted); }
    $todayMl = $byDate[$date] ?? 0;
    $yKey = add_days($date, -1);
    $goal = $profile['waterGoalMl'];
    return [
        'date' => $date, 'goalMl' => $goal, 'unit' => $profile['waterUnit'], 'todayMl' => $todayMl,
        'remainingMl' => max(0, $goal - $todayMl),
        'percent' => min(100, jsround(($todayMl / $goal) * 100)),
        'yesterdayMl' => $byDate[$yKey] ?? 0,
        'weeklyAverageMl' => jsround(array_sum(array_column($last7, 'ml')) / 7),
        'monthlyAverageMl' => $byDate ? jsround(array_sum($byDate) / count($byDate)) : 0,
        'bestDay' => $bestKey !== null ? ['date' => (string)$bestKey, 'ml' => $byDate[$bestKey]] : null,
        'last7' => $last7,
        'todayEntries' => array_values(array_filter($entries, fn($e) => ($e['localDate'] ?: local_date($e['at'])) === $date))
    ];
});

route('POST', '/water', function () {
    $ml = jsround((float)js_float(in_body('ml')));
    if (!$ml) respond(400, ['error' => 'ml is required']);
    $date = truthy(in_body('date')) ? in_body('date') : today_local();
    respond(201, ['entry' => create('tracker_water_entries', ['userId' => me()['id'], 'ml' => $ml, 'localDate' => $date])]);
});

route('DELETE', '/water/:id', function ($p) {
    $e = find_one('tracker_water_entries', ['id' => js_int($p['id']), 'userId' => me()['id']]);
    if (!$e) respond(404, ['error' => 'Entry not found']);
    destroy('tracker_water_entries', ['id' => $e['id']]);
    return ['ok' => true];
});

/* ---------------- daily tasks ---------------- */
route('GET', '/tasks', function () {
    $date = local_date_of_req();
    $done = [];
    foreach (find_all('tracker_task_logs', ['userId' => me()['id'], 'date' => $date]) as $d) $done[$d['taskKey']] = true;
    $tasks = array_map(fn($t) => array_merge((array)$t, ['done' => isset($done[$t->key])]), fasting_data()->DAILY_TASKS);
    return ['date' => $date, 'tasks' => $tasks, 'completed' => count($done), 'total' => count(fasting_data()->DAILY_TASKS)];
});

route('POST', '/tasks/:key', function ($p) {
    $date = truthy(in_body('date')) ? in_body('date') : today_local();
    $key = $p['key'];
    $known = array_filter(fasting_data()->DAILY_TASKS, fn($t) => $t->key === $key);
    if (!$known) respond(404, ['error' => 'Unknown task']);
    $existing = find_one('tracker_task_logs', ['userId' => me()['id'], 'date' => $date, 'taskKey' => $key]);
    if ($existing) { destroy('tracker_task_logs', ['id' => $existing['id']]); return ['key' => $key, 'done' => false]; }
    create('tracker_task_logs', ['userId' => me()['id'], 'date' => $date, 'taskKey' => $key]);
    return ['key' => $key, 'done' => true];
});

/* ---------------- dashboard roll-up ---------------- */
route('GET', '/dashboard', function () {
    $date = local_date_of_req();
    $state = build_state(me(), $date);
    $profile = $state['profile'];
    $meals = find_all('meal_entries', ['userId' => me()['id'], 'date' => $date]);
    $water = find_all('tracker_water_entries', ['userId' => me()['id'], 'localDate' => $date]);
    $weights = find_all('weight_logs', ['userId' => me()['id']], [['date', 'DESC']], 2);
    return [
        'date' => $date, 'state' => $state, 'tipOfDay' => tip_for_date($date),
        'nutrition' => ['calories' => jsround(array_sum(array_map(fn($m) => $m['calories'] ?: 0, $meals))), 'goal' => $profile['calorieGoal'], 'mealCount' => count($meals)],
        'water' => ['ml' => array_sum(array_column($water, 'ml')), 'goalMl' => $profile['waterGoalMl'], 'unit' => $profile['waterUnit']],
        'tasks' => ['completed' => count_rows('tracker_task_logs', ['userId' => me()['id'], 'date' => $date]), 'total' => count(fasting_data()->DAILY_TASKS)],
        'weight' => $weights ? [
            'currentKg' => $weights[0]['weightKg'],
            'previousKg' => isset($weights[1]) ? $weights[1]['weightKg'] : null,
            'changeKg' => isset($weights[1]) ? round1($weights[0]['weightKg'] - $weights[1]['weightKg']) : null
        ] : null
    ];
}, ['err' => 'Could not load tracker dashboard']);
