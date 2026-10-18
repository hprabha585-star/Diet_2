<?php
/* ============================================================
   App logic shared by all routes — direct ports of
   models/index.js (User methods), utils/helpers.js,
   utils/scoring.js, utils/fastingContent.js helpers.
   ============================================================ */

/* ---------------- static content ---------------- */
function data_json($name) {
    static $cache = [];
    if (!isset($cache[$name])) $cache[$name] = json_decode(file_get_contents(__DIR__ . "/../data/$name.json"));
    return $cache[$name];
}
function protocol_data() { return data_json('protocol'); }
function fasting_data() { return data_json('fasting'); }

function stage_for($hours) {
    $stages = fasting_data()->STAGES;
    foreach ($stages as $s) if ($hours >= $s->from && $hours < $s->to) return $s;
    return $stages[count($stages) - 1];
}
function tip_for_date($dateStr) {
    $seed = str_replace('-', '', (string)$dateStr);
    $n = js_int($seed) ?? 0;
    $tips = fasting_data()->TIPS;
    return $tips[$n % count($tips)];
}

/* ---------------- User "model methods" ---------------- */
function has_protocol_mode($u) { return $u['hasProtocolAccess'] || $u['planMode'] === 'protocol'; }
function has_tracker_mode($u) { return $u['hasTrackerAccess'] || $u['planMode'] === 'tracker'; }
function is_dual_access($u) { return has_protocol_mode($u) && has_tracker_mode($u); }

function current_challenge_day($u) {
    if (!$u['challengeStartDate']) return 0;
    $today = ($u['pauseActive'] && $u['pauseStartedAt']) ? local_date($u['pauseStartedAt']) : today_local();
    $day = day_diff($u['challengeStartDate'], $today) + 1 - ($u['pausedDays'] ?: 0);
    return max(0, min($day, $u['challengeLengthDays']));
}
function due_date($u) {
    if (!$u['challengeStartDate']) return null;
    return add_days($u['challengeStartDate'], $u['challengeLengthDays'] + ($u['pausedDays'] ?: 0));
}
function elapsed_challenge_day($u) {
    if (!$u['challengeStartDate']) return 0;
    return day_diff($u['challengeStartDate'], today_local()) + 1 - ($u['pausedDays'] ?: 0);
}
function days_left($u) {
    if (!$u['challengeStartDate']) return null;
    return max(0, $u['challengeLengthDays'] - elapsed_challenge_day($u));
}
function is_expired($u) {
    if (!$u['challengeStartDate']) return false;
    return elapsed_challenge_day($u) > $u['challengeLengthDays'];
}
function bmi_of($u, $latestWeightKg = null) {
    $w = $latestWeightKg ?: $u['startWeightKg'];
    if (!$w || !$u['heightCm']) return null;
    $m = $u['heightCm'] / 100;
    return round1($w / ($m * $m));
}
function healthy_weight_range($u) {
    if (!$u['heightCm']) return null;
    $m = $u['heightCm'] / 100;
    return ['minKg' => round1(18.5 * $m * $m), 'maxKg' => round1(24.9 * $m * $m)];
}
function safe_user($u) { unset($u['passwordHash']); return $u; }

/* ---------------- helpers.js ---------------- */
function generate_referral_code($name) {
    $base = strtoupper(substr(preg_replace('/[^a-zA-Z]/', '', $name ?: 'FC'), 0, 4));
    if ($base === '') $base = 'FCUS';
    $chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    $rand = '';
    for ($i = 0; $i < 4; $i++) $rand .= $chars[random_int(0, 35)];
    return $base . strtoupper($rand);
}
function unique_referral_code($name) {
    do { $code = generate_referral_code($name); } while (find_one('users', ['referralCode' => $code]));
    return $code;
}

function build_checklist_items($regimen) {
    $seen = [];
    $unique = function ($base) use (&$seen) {
        $key = $base; $n = 2;
        while (isset($seen[$key])) $key = $base . '_' . $n++;
        $seen[$key] = true;
        return $key;
    };
    $items = [];
    foreach ($regimen['meals'] ?? [] as $m) {
        $items[] = [
            'itemKey' => $unique('meal_' . $m['type']),
            'label' => $m['calories'] ? "{$m['name']} ({$m['calories']} kcal)" : $m['name'],
            'kind' => 'meal', 'done' => false, 'custom' => false
        ];
    }
    foreach ($regimen['milestones'] ?? [] as $m) {
        $items[] = [
            'itemKey' => $unique('habit_' . ($m['itemKey'] ?? '')),
            'label' => $m['label'], 'kind' => 'habit', 'done' => false, 'custom' => false
        ];
    }
    return $items;
}

/** Regimen row with its meals + milestones attached (Sequelize include). */
function load_regimen($userId, $day) {
    $r = find_one('regimens', ['userId' => $userId, 'day' => $day]);
    if (!$r) return null;
    return attach_regimen_children($r);
}
function attach_regimen_children($r) {
    $r['meals'] = find_all('regimen_meals', ['regimenId' => $r['id']], [['id', 'ASC']]);
    $r['milestones'] = find_all('regimen_milestones', ['regimenId' => $r['id']], [['id', 'ASC']]);
    return $r;
}

/* ---------------- scoring.js ---------------- */
const POINTS_PER_DAY = 100;
const COMPLETION_THRESHOLD = 80;

function completion_of($items) {
    $scored = array_values(array_filter($items ?: [], fn($i) => !$i['custom']));
    if (!$scored) return ['percent' => 0, 'done' => 0, 'total' => 0, 'qualifies' => false];
    $done = count(array_filter($scored, fn($i) => $i['done']));
    $percent = jsround(($done / count($scored)) * 100);
    return ['percent' => $percent, 'done' => $done, 'total' => count($scored), 'qualifies' => $percent >= COMPLETION_THRESHOLD];
}

function rescore_day($userId, $day) {
    $log = find_one('checklist_logs', ['userId' => $userId, 'day' => $day]);
    if (!$log) return ['percent' => 0, 'done' => 0, 'total' => 0, 'qualifies' => false];
    $items = find_all('checklist_items', ['checklistLogId' => $log['id']]);
    $result = completion_of($items);
    if ($log['completionPercent'] !== $result['percent'] || $log['streakCounted'] !== $result['qualifies']) {
        save('checklist_logs', $log, ['completionPercent' => $result['percent'], 'streakCounted' => $result['qualifies']]);
    }
    return $result;
}

/** Recompute points/streaks from ChecklistLog rows; saves the user if changed. */
function recalc_user_score($user) {
    $today = current_challenge_day($user);
    $logs = find_all('checklist_logs', ['userId' => $user['id']], [['day', 'ASC']]);
    $qualifying = [];
    foreach ($logs as $l) if ($l['streakCounted'] && $l['day'] <= $today) $qualifying[$l['day']] = true;

    $points = count($qualifying) * POINTS_PER_DAY;
    $sorted = array_keys($qualifying); sort($sorted);
    $best = 0; $run = 0; $prev = null;
    foreach ($sorted as $d) {
        $run = ($prev !== null && $d === $prev + 1) ? $run + 1 : 1;
        $best = max($best, $run);
        $prev = $d;
    }
    $cursor = isset($qualifying[$today]) ? $today : $today - 1;
    $current = 0;
    while ($cursor >= 1 && isset($qualifying[$cursor])) { $current++; $cursor--; }

    if ($user['points'] !== $points || $user['streakCurrent'] !== $current || $user['streakBest'] !== $best) {
        $user = save('users', $user, ['points' => $points, 'streakCurrent' => $current, 'streakBest' => $best]);
        global $CURRENT_USER;
        if ($CURRENT_USER && $CURRENT_USER['id'] === $user['id']) $CURRENT_USER = $user;
    }
    return ['points' => $points, 'streakCurrent' => $current, 'streakBest' => $best];
}

function apply_scoring($user, $day) {
    $dayResult = rescore_day($user['id'], $day);
    $totals = recalc_user_score($user);
    return array_merge($dayResult, $totals);
}

/* ---------------- backfillAccess.js (run once after install/import) ---------------- */
function backfill_dual_plan_access() {
    $clients = find_all('users', ['role' => 'client']);
    $payments = find_all('payments', ['status' => 'approved']);
    $modeByTier = [];
    foreach (find_all('plans') as $p) $modeByTier[$p['key']] = $p['mode'];
    $byUser = [];
    foreach ($payments as $pay) $byUser[$pay['userId']][] = $pay;
    $fixed = 0;
    foreach ($clients as $c) {
        $needP = $c['hasProtocolAccess'] || $c['planMode'] === 'protocol';
        $needT = $c['hasTrackerAccess'] || $c['planMode'] === 'tracker';
        foreach ($byUser[$c['id']] ?? [] as $pay) {
            $mode = $modeByTier[$pay['tier']] ?? null;
            if ($mode === 'tracker') $needT = true; elseif ($mode === 'protocol') $needP = true;
        }
        if ($needP !== (bool)$c['hasProtocolAccess'] || $needT !== (bool)$c['hasTrackerAccess']) {
            save('users', $c, ['hasProtocolAccess' => $needP, 'hasTrackerAccess' => $needT]);
            $fixed++;
        }
    }
    return $fixed;
}

/* ---------------- Settings / Plans / ProtocolDay helpers ---------------- */
function settings_get_or_create() {
    $s = find_one('settings', ['singleton' => 'main']);
    if (!$s) $s = create('settings', ['singleton' => 'main']);
    return $s;
}
function plans_seed_if_empty($where = []) {
    if (count_rows('plans') === 0) {
        foreach (data_json('plan_defaults') as $p) create('plans', (array)$p + ['features' => []]);
    }
}
function protocol_days_all_or_seed() {
    $rows = find_all('protocol_days', [], [['day', 'ASC']]);
    if (!$rows) {
        foreach (protocol_data()->PROTOCOL_DAYS as $d) create('protocol_days', (array)$d);
        $rows = find_all('protocol_days', [], [['day', 'ASC']]);
    }
    return $rows;
}
function tracker_profile_for($userId) {
    $p = find_one('tracker_profiles', ['userId' => $userId]);
    if (!$p) $p = create('tracker_profiles', ['userId' => $userId]);
    return $p;
}
