/* ============================================================
   Points / streak scoring — SINGLE SOURCE OF TRUTH.

   The old code incremented `user.points += 100` inside the toggle
   route the first time a day happened to cross 80%. That was wrong in
   four separate ways:

     1. It scored a SNAPSHOT. If a client ticked the only meal that
        existed at that moment (1/1 = 100%), they banked 100 points —
        and when the coach later assigned three more meals the day fell
        to 25% but the points and the streak stayed. (This is exactly
        the "100 points on day 1 with one meal ticked" case.)
     2. It never un-awarded. Untick everything and you keep the points.
     3. `/dashboard` also wrote `log.completionPercent` — so the day
        could reach 80% there, and afterwards the toggle route's
        `log.completionPercent < 80` guard was already false and the
        points were never granted at all.
     4. `streakCurrent += 1` never reset on a missed day, so the streak
        only ever went up.

   Fix: points and streaks are DERIVED, never incremented. Every write
   recomputes them from the ChecklistLog rows, so the numbers are
   idempotent — running it twice changes nothing, and running it after
   the coach edits a plan corrects itself automatically.
   ============================================================ */

const { ChecklistLog, ChecklistItem } = require('../models');

const POINTS_PER_DAY = 100;
const COMPLETION_THRESHOLD = 80; // % of coach-assigned items needed to score the day

/**
 * Completion % for one day. ONLY coach-assigned items count
 * (custom === false). A day with no coach items assigned yet is 0% and
 * can never qualify — otherwise "0 of 0 done" would read as 100%.
 */
function completionOf(items) {
  const scored = (items || []).filter(i => !i.custom);
  if (!scored.length) return { percent: 0, done: 0, total: 0, qualifies: false };
  const done = scored.filter(i => i.done).length;
  const percent = Math.round((done / scored.length) * 100);
  return { percent, done, total: scored.length, qualifies: percent >= COMPLETION_THRESHOLD };
}

/**
 * Recompute one day's stored completionPercent + streakCounted flag.
 * Returns the fresh numbers. Safe to call as often as you like.
 */
async function rescoreDay(userId, day) {
  const log = await ChecklistLog.findOne({
    where: { userId, day },
    include: [{ model: ChecklistItem, as: 'items' }]
  });
  if (!log) return { percent: 0, done: 0, total: 0, qualifies: false };

  const result = completionOf(log.items);
  if (log.completionPercent !== result.percent || log.streakCounted !== result.qualifies) {
    log.completionPercent = result.percent;
    log.streakCounted = result.qualifies; // can go back to false — that's the point
    await log.save();
  }
  return result;
}

/**
 * Recompute points, current streak and best streak for a user from
 * scratch, out of the ChecklistLog table.
 *
 *  points        = 100 per qualifying day
 *  streakBest    = longest run of consecutive qualifying days ever
 *  streakCurrent = run ending today (or ending yesterday if today
 *                  isn't finished yet — a streak shouldn't "break" at
 *                  midnight just because you haven't ticked anything
 *                  since waking up)
 */
async function recalcUserScore(user) {
  const today = user.currentChallengeDay();
  const logs = await ChecklistLog.findAll({
    where: { userId: user.id },
    order: [['day', 'ASC']],
    attributes: ['day', 'streakCounted']
  });

  const qualifying = new Set(
    logs.filter(l => l.streakCounted && l.day <= today).map(l => l.day)
  );

  const points = qualifying.size * POINTS_PER_DAY;

  // Longest run ever
  let best = 0, run = 0;
  const sorted = [...qualifying].sort((a, b) => a - b);
  let prev = null;
  for (const d of sorted) {
    run = prev !== null && d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }

  // Current run: start at today if today already qualifies, else at
  // yesterday (today is still in progress).
  let cursor = qualifying.has(today) ? today : today - 1;
  let current = 0;
  while (cursor >= 1 && qualifying.has(cursor)) { current++; cursor--; }

  if (user.points !== points || user.streakCurrent !== current || user.streakBest !== best) {
    user.points = points;
    user.streakCurrent = current;
    user.streakBest = best;
    await user.save();
  }
  return { points, streakCurrent: current, streakBest: best };
}

/**
 * The one call every route should use after touching a checklist:
 * rescore the day, then rebuild the user's totals from all days.
 */
async function applyScoring(user, day) {
  const dayResult = await rescoreDay(user.id, day);
  const totals = await recalcUserScore(user);
  return { ...dayResult, ...totals };
}

module.exports = {
  POINTS_PER_DAY, COMPLETION_THRESHOLD,
  completionOf, rescoreDay, recalcUserScore, applyScoring
};