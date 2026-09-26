const express = require('express');
const {
  User, WeightLog, Plan, Payment, Payout,
  Regimen, RegimenMeal, RegimenMilestone,
  ChecklistLog, ChecklistItem, WaterEntry,
  Alert, AlertRead, Message, Settings, TrackerSession, TrackerWaterEntry
} = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildChecklistItems } = require('../utils/helpers');
// Points/streak are DERIVED here, never incremented — see utils/scoring.js
const { applyScoring, completionOf, COMPLETION_THRESHOLD, POINTS_PER_DAY } = require('../utils/scoring');
const { Op } = require('sequelize');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

// Everything except payment status, contact, and chat is locked until the
// coach approves the client's payment. The API refuses these routes itself
// rather than relying on the UI to hide them.
function requireActive(req, res, next) {
  if (req.user.status !== 'active' && req.user.status !== 'paused') {
    return res.status(403).json({ error: 'Your account is not active yet. Please complete payment and wait for coach approval.' });
  }
  next();
}

async function getOrCreateChecklistLog(userId, day) {
  let log = await ChecklistLog.findOne({ where: { userId, day }, include: [{ model: ChecklistItem, as: 'items' }, { model: WaterEntry, as: 'waterEntries' }] });
  if (!log) {
    log = await ChecklistLog.create({ userId, day });
    log.items = [];
    log.waterEntries = [];
  }
  return log;
}

// Re-sync today's checklist against the coach's current assigned regimen:
// new meals/habits appear, removed ones go, ticks are preserved, and the
// client's own custom items are left untouched.
async function syncChecklistWithRegimen(user, day) {
  const regimen = await Regimen.findOne({
    where: { userId: user.id, day },
    include: [{ model: RegimenMeal, as: 'meals' }, { model: RegimenMilestone, as: 'milestones' }]
  });
  const log = await getOrCreateChecklistLog(user.id, day);
  if (!regimen) return { regimen: null, log };

  const desired = buildChecklistItems(regimen); // coach items only, custom:false
  const existingCoachItems = log.items.filter(i => !i.custom);
  const existingCustomItems = log.items.filter(i => i.custom);
  const existingByKey = new Map(existingCoachItems.map(i => [i.itemKey, i]));
  const desiredKeys = new Set(desired.map(d => d.itemKey));

  // Remove coach items no longer in the regimen
  for (const item of existingCoachItems) {
    if (!desiredKeys.has(item.itemKey)) await item.destroy();
  }
  // Add new coach items, preserve ticks on ones that still exist
  for (const d of desired) {
    if (!existingByKey.has(d.itemKey)) {
      await ChecklistItem.create({ checklistLogId: log.id, ...d });
    }
  }
  const refreshed = await getOrCreateChecklistLog(user.id, day);
  return { regimen, log: refreshed };
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                            */
/* ------------------------------------------------------------------ */
router.get('/dashboard', requireActive, async (req, res) => {
  try {
    const user = req.user;

    if (user.planMode === 'tracker') {
      const running = await TrackerSession.findOne({ where: { userId: user.id, status: 'running' } });
      const recent = await TrackerSession.findAll({ where: { userId: user.id }, order: [['startAt', 'DESC']], limit: 10 });
      return res.json({
        planMode: 'tracker',
        user: user.toSafeJSON(),
        running,
        recentSessions: recent
      });
    }

    const day = user.currentChallengeDay();
    const { regimen, log } = await syncChecklistWithRegimen(user, day);
    // The coach may have added or removed items since the last tick, so the
    // day is re-scored here too — that is what stops a day from keeping
    // points it no longer earns.
    const score = await applyScoring(user, day);

    res.json({
      planMode: 'protocol',
      user: user.toSafeJSON(),
      day,
      challengeLengthDays: user.challengeLengthDays,
      fastingPause: { active: user.pauseActive, reason: user.pauseReason },
      // Only raw window data goes to the client — it computes fasting/eating
      // state and the countdown itself in the browser's local time, so the
      // number is always correct regardless of the server's timezone.
      regimen: regimen ? {
        day: regimen.day,
        startHour: regimen.startHour,
        endHour: regimen.endHour,
        isFullDayFast: regimen.isFullDayFast,
        protocolType: regimen.protocolType,
        phase: regimen.phase,
        focus: regimen.focus,
        dayInfo: regimen.dayInfo,
        waterTargetMl: regimen.waterTargetMl
      } : null,
      checklist: {
        meals: log.items.filter(i => i.kind === 'meal'),
        habits: log.items.filter(i => i.kind === 'habit'),
        completionPercent: score.percent,
        scoredDone: score.done,          // coach items ticked
        scoredTotal: score.total,        // coach items assigned
        threshold: COMPLETION_THRESHOLD, // % needed to bank the day
        pointsPerDay: POINTS_PER_DAY,
        dayScored: score.qualifies,
        waterMl: log.waterMl,
        waterEntries: log.waterEntries
      }
    });
  } catch (err) {
    // This route previously had no try/catch at all: a DB error here (e.g.
    // a column the app expects but a migration hasn't added yet) became an
    // unhandled promise rejection, which crashed the whole Node process
    // instead of just failing this one request. Catching it here means a
    // future hiccup returns a 500 to this one client instead of taking the
    // entire site down for everyone.
    console.error('GET /client/dashboard failed:', err);
    res.status(500).json({ error: 'Could not load dashboard', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Checklist — coach items: tick/untick ONLY. Custom items: full CRUD, */
/* never scored.                                                        */
/* ------------------------------------------------------------------ */

// POST /client/checklist  { itemId, done }  — toggle any item (coach or custom)
router.post('/checklist', requireActive, async (req, res) => {
  try {
    const { itemId, done } = req.body;
    const item = await ChecklistItem.findByPk(itemId, { include: [{ model: ChecklistLog }] });
    if (!item || item.ChecklistLog.userId !== req.user.id) return res.status(404).json({ error: 'Item not found' });

    const day = item.ChecklistLog.day;
    const wasScored = item.ChecklistLog.streakCounted;

    item.done = !!done;
    await item.save();

    // Recompute the day and the user's totals from the database. No
    // `+= 100` anywhere: the day is either qualifying or it isn't, and
    // the totals always match the rows.
    const score = await applyScoring(req.user, day);

    res.json({
      item,
      completionPercent: score.percent,
      scoredDone: score.done,
      scoredTotal: score.total,
      threshold: COMPLETION_THRESHOLD,
      pointsPerDay: POINTS_PER_DAY,
      dayScored: score.qualifies,
      awardedPoints: score.qualifies && !wasScored,   // just crossed the line
      revokedPoints: !score.qualifies && wasScored,   // just dropped back under it
      points: score.points,
      streakCurrent: score.streakCurrent,
      streakBest: score.streakBest
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not update checklist item', detail: err.message });
  }
});

// POST /client/checklist/items  — add a custom habit or meal (never scored)
router.post('/checklist/items', requireActive, async (req, res) => {
  try {
    const { label, kind } = req.body;
    if (!label) return res.status(400).json({ error: 'Label is required' });
    const day = req.user.currentChallengeDay();
    const log = await getOrCreateChecklistLog(req.user.id, day);
    const itemKey = `custom_${Date.now()}`;
    const item = await ChecklistItem.create({
      checklistLogId: log.id, itemKey, label,
      kind: kind === 'meal' ? 'meal' : 'habit',
      done: false, custom: true
    });
    res.status(201).json({ item });
  } catch (err) {
    res.status(500).json({ error: 'Could not add item', detail: err.message });
  }
});

// PATCH /client/checklist/items/:id  { label }  — rename; CUSTOM ITEMS ONLY
router.patch('/checklist/items/:id', requireActive, async (req, res) => {
  try {
    const item = await ChecklistItem.findByPk(req.params.id, { include: [{ model: ChecklistLog }] });
    if (!item || item.ChecklistLog.userId !== req.user.id) return res.status(404).json({ error: 'Item not found' });
    if (!item.custom) return res.status(403).json({ error: "Coach-assigned items can only be ticked or unticked, not edited." });

    if (typeof req.body.label === 'string' && req.body.label.trim()) item.label = req.body.label.trim();
    await item.save();
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: 'Could not update item', detail: err.message });
  }
});

// DELETE /client/checklist/items/:id  — CUSTOM ITEMS ONLY
router.delete('/checklist/items/:id', requireActive, async (req, res) => {
  try {
    const item = await ChecklistItem.findByPk(req.params.id, { include: [{ model: ChecklistLog }] });
    if (!item || item.ChecklistLog.userId !== req.user.id) return res.status(404).json({ error: 'Item not found' });
    if (!item.custom) return res.status(403).json({ error: 'Coach-assigned items cannot be deleted.' });

    await item.destroy();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete item', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Water                                                                 */
/* ------------------------------------------------------------------ */
router.post('/water', requireActive, async (req, res) => {
  try {
    const { ml } = req.body;
    if (!ml || ml <= 0) return res.status(400).json({ error: 'ml must be a positive number' });
    const day = req.user.currentChallengeDay();
    const log = await getOrCreateChecklistLog(req.user.id, day);
    await WaterEntry.create({ checklistLogId: log.id, ml });
    const entries = await WaterEntry.findAll({ where: { checklistLogId: log.id } });
    log.waterMl = entries.reduce((sum, e) => sum + e.ml, 0);
    await log.save();
    res.status(201).json({ waterMl: log.waterMl, entries });
  } catch (err) {
    res.status(500).json({ error: 'Could not log water', detail: err.message });
  }
});

router.patch('/water/:entryId', requireActive, async (req, res) => {
  try {
    const entry = await WaterEntry.findByPk(req.params.entryId, { include: [{ model: ChecklistLog }] });
    if (!entry || entry.ChecklistLog.userId !== req.user.id) return res.status(404).json({ error: 'Entry not found' });
    if (req.body.ml) entry.ml = req.body.ml;
    await entry.save();
    const entries = await WaterEntry.findAll({ where: { checklistLogId: entry.checklistLogId } });
    const log = entry.ChecklistLog;
    log.waterMl = entries.reduce((sum, e) => sum + e.ml, 0);
    await log.save();
    res.json({ entry, waterMl: log.waterMl });
  } catch (err) {
    res.status(500).json({ error: 'Could not update entry', detail: err.message });
  }
});

router.delete('/water/:entryId', requireActive, async (req, res) => {
  try {
    const entry = await WaterEntry.findByPk(req.params.entryId, { include: [{ model: ChecklistLog }] });
    if (!entry || entry.ChecklistLog.userId !== req.user.id) return res.status(404).json({ error: 'Entry not found' });
    const log = entry.ChecklistLog;
    await entry.destroy();
    const entries = await WaterEntry.findAll({ where: { checklistLogId: log.id } });
    log.waterMl = entries.reduce((sum, e) => sum + e.ml, 0);
    await log.save();
    res.json({ ok: true, waterMl: log.waterMl });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete entry', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Fasting pause / resume                                               */
/* ------------------------------------------------------------------ */
router.post('/fasting/pause', requireActive, async (req, res) => {
  const user = req.user;
  user.pauseActive = true;
  user.pauseReason = req.body.reason || '';
  user.pauseStartedAt = new Date();
  await user.save();
  res.json({ fastingPause: { active: true, reason: user.pauseReason }, day: user.currentChallengeDay() });
});

router.post('/fasting/resume', requireActive, async (req, res) => {
  const user = req.user;
  if (user.pauseActive && user.pauseStartedAt) {
    const start = new Date(user.pauseStartedAt);
    const now = new Date();
    const startLocal = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const nowLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const frozenDays = Math.max(0, Math.round((nowLocal - startLocal) / 86400000));
    user.pausedDays = (user.pausedDays || 0) + frozenDays;
  }
  user.pauseActive = false;
  user.pauseReason = '';
  user.pauseLastResumedAt = new Date();
  await user.save();
  res.json({ fastingPause: { active: false }, pausedDays: user.pausedDays, day: user.currentChallengeDay() });
});

/* ------------------------------------------------------------------ */
/* Weight / BMI                                                         */
/* ------------------------------------------------------------------ */
router.post('/weight', requireActive, async (req, res) => {
  try {
    const { weightKg, note } = req.body;
    if (!weightKg) return res.status(400).json({ error: 'weightKg is required' });
    // BMI is computed and frozen onto the log at the moment it's saved —
    // same "Save" action that logs the weight, so history shows the BMI
    // as it stood on that day (needs heightCm already on the profile;
    // null otherwise, same as req.user.bmi() would return).
    const bmiAtLog = req.user.bmi(weightKg);
    const log = await WeightLog.create({ userId: req.user.id, weightKg, note, bmiAtLog });
    res.status(201).json({ log, bmi: bmiAtLog, healthyWeightRange: req.user.healthyWeightRange() });
  } catch (err) {
    res.status(500).json({ error: 'Could not log weight', detail: err.message });
  }
});

router.patch('/weight/:logId', requireActive, async (req, res) => {
  try {
    const log = await WeightLog.findOne({ where: { id: req.params.logId, userId: req.user.id } });
    if (!log) return res.status(404).json({ error: 'Weight entry not found' });
    if (req.body.weightKg) log.weightKg = req.body.weightKg;
    if (typeof req.body.note === 'string') log.note = req.body.note;
    await log.save();
    res.json({ log });
  } catch (err) {
    res.status(500).json({ error: 'Could not update entry', detail: err.message });
  }
});

router.delete('/weight/:logId', requireActive, async (req, res) => {
  try {
    const log = await WeightLog.findOne({ where: { id: req.params.logId, userId: req.user.id } });
    if (!log) return res.status(404).json({ error: 'Weight entry not found' });
    await log.destroy();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete entry', detail: err.message });
  }
});

router.post('/profile', requireActive, async (req, res) => {
  try {
    const { heightCm, age, gender } = req.body;
    if (heightCm) req.user.heightCm = heightCm;
    if (age) req.user.age = age;
    if (gender) req.user.gender = gender;
    await req.user.save();
    res.json({ user: req.user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Could not save profile', detail: err.message });
  }
});

// GET /client/profile-summary — the small set of facts the "profile" popup
// shows: name, age, current weight, height, BMI. Used in place of a plain
// name in the topbar so the client can see this at a glance from any page.
router.get('/profile-summary', requireActive, async (req, res) => {
  try {
    const latest = await WeightLog.findOne({ where: { userId: req.user.id }, order: [['date', 'DESC']] });
    const currentWeightKg = latest ? latest.weightKg : req.user.startWeightKg;
    res.json({
      name: req.user.name,
      age: req.user.age,
      gender: req.user.gender,
      heightCm: req.user.heightCm,
      currentWeightKg,
      bmi: req.user.bmi(currentWeightKg),
      healthyWeightRange: req.user.healthyWeightRange(),
      day: req.user.currentChallengeDay(),
      challengeLengthDays: req.user.challengeLengthDays
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load profile', detail: err.message });
  }
});

router.get('/history', requireActive, async (req, res) => {
  const weightLogs = await WeightLog.findAll({ where: { userId: req.user.id }, order: [['date', 'ASC']] });
  const checklistLogs = await ChecklistLog.findAll({ where: { userId: req.user.id }, order: [['day', 'ASC']] });
  res.json({ weightLogs, checklistLogs, bmi: req.user.bmi(), healthyWeightRange: req.user.healthyWeightRange() });
});

/* ------------------------------------------------------------------ */
/* Leaderboard                                                           */
/* ------------------------------------------------------------------ */
router.get('/leaderboard', requireActive, async (req, res) => {
  const clients = await User.findAll({
    where: { role: 'client', planMode: 'protocol', status: { [Op.in]: ['active', 'paused'] } },
    order: [['points', 'DESC']],
    attributes: ['id', 'name', 'points', 'streakCurrent', 'streakBest']
  });
  res.json({ leaderboard: clients });
});

/* ------------------------------------------------------------------ */
/* Referral                                                              */
/* ------------------------------------------------------------------ */
router.get('/referral', requireActive, async (req, res) => {
  const referredCount = await User.count({ where: { referredBy: req.user.id } });
  res.json({
    referralCode: req.user.referralCode,
    walletBalanceInr: req.user.walletBalanceInr,
    referredCount
  });
});

router.post('/payout-request', requireActive, async (req, res) => {
  try {
    const { amountInr, upiId } = req.body;
    if (!amountInr || !upiId) return res.status(400).json({ error: 'amountInr and upiId are required' });
    if (amountInr > req.user.walletBalanceInr) return res.status(400).json({ error: 'Amount exceeds wallet balance' });
    const payout = await Payout.create({ userId: req.user.id, amountInr, upiId });
    res.status(201).json({ payout });
  } catch (err) {
    res.status(500).json({ error: 'Could not request payout', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Payments (available even before activation)                          */
/* ------------------------------------------------------------------ */
router.post('/payments', async (req, res) => {
  try {
    const { tier, utr, screenshotBase64 } = req.body;
    if (!tier || !utr) return res.status(400).json({ error: 'Plan and UTR are required' });
    const plan = await Plan.findOne({ where: { key: tier, active: true } });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const payment = await Payment.create({
      userId: req.user.id, tier: plan.key, planName: plan.name,
      amountInr: plan.priceInr, utr, screenshotBase64
    });
    res.status(201).json({ payment });
  } catch (err) {
    res.status(500).json({ error: 'Could not submit payment', detail: err.message });
  }
});

router.get('/payment-status', async (req, res) => {
  const last = await Payment.findOne({ where: { userId: req.user.id }, order: [['createdAt', 'DESC']] });
  res.json({ status: req.user.status, lastPayment: last });
});

router.get('/plans', async (req, res) => {
  const plans = await Plan.findAll({ where: { active: true }, order: [['order', 'ASC'], ['priceInr', 'ASC']] });
  res.json({ plans });
});

/* ------------------------------------------------------------------ */
/* Fasting Tracker plan — fully self-guided, no coach involvement       */
/* ------------------------------------------------------------------ */
router.post('/tracker/start', requireActive, async (req, res) => {
  try {
    if (req.user.planMode !== 'tracker') return res.status(403).json({ error: 'Not on the Fasting Tracker plan' });
    const existing = await TrackerSession.findOne({ where: { userId: req.user.id, status: 'running' } });
    if (existing) return res.status(409).json({ error: 'A fast is already running' });

    const { targetHours } = req.body;
    if (!targetHours || targetHours <= 0) return res.status(400).json({ error: 'targetHours is required' });
    const session = await TrackerSession.create({ userId: req.user.id, startAt: new Date(), targetHours, status: 'running' });
    res.status(201).json({ session });
  } catch (err) {
    res.status(500).json({ error: 'Could not start fast', detail: err.message });
  }
});

router.post('/tracker/stop', requireActive, async (req, res) => {
  try {
    const session = await TrackerSession.findOne({ where: { userId: req.user.id, status: 'running' } });
    if (!session) return res.status(404).json({ error: 'No fast is running' });
    session.endAt = new Date();
    const actualHours = (session.endAt - session.startAt) / 3600000;
    session.status = actualHours >= session.targetHours ? 'completed' : 'broken';
    if (typeof req.body.note === 'string') session.note = req.body.note;
    await session.save();
    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: 'Could not stop fast', detail: err.message });
  }
});

router.get('/tracker/history', requireActive, async (req, res) => {
  const sessions = await TrackerSession.findAll({ where: { userId: req.user.id }, order: [['startAt', 'DESC']], limit: 60 });
  res.json({ sessions });
});

// PATCH /client/tracker/session/:id  { startAt, targetHours }  — edit a running
// fast (the "pencil" edit on the timer, e.g. "actually started earlier").
router.patch('/tracker/session/:id', requireActive, async (req, res) => {
  try {
    const session = await TrackerSession.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!session) return res.status(404).json({ error: 'Fast not found' });
    if (session.status !== 'running') return res.status(400).json({ error: 'Only a running fast can be edited' });
    if (req.body.startAt) session.startAt = new Date(req.body.startAt);
    if (req.body.targetHours) session.targetHours = req.body.targetHours;
    await session.save();
    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: 'Could not update fast', detail: err.message });
  }
});

// GET /client/tracker/stats — the motivational numbers behind the
// "Visualize your experience" style card: total fasts, longest fast,
// rolling average, current/longest streak of days with a completed fast.
router.get('/tracker/stats', requireActive, async (req, res) => {
  const sessions = await TrackerSession.findAll({ where: { userId: req.user.id, status: { [Op.in]: ['completed', 'broken'] } }, order: [['startAt', 'DESC']] });
  const completed = sessions.filter(s => s.status === 'completed');
  const hoursOf = (s) => (new Date(s.endAt) - new Date(s.startAt)) / 3600000;

  const totalFasts = sessions.length;
  const longestFastHours = sessions.length ? Math.max(...sessions.map(hoursOf)) : 0;
  const last7 = sessions.slice(0, 7);
  const avg7 = last7.length ? last7.reduce((sum, s) => sum + hoursOf(s), 0) / last7.length : 0;

  // Streak = consecutive calendar days (most recent first) with at least
  // one COMPLETED fast that started that day.
  const daysWithCompleted = new Set(completed.map(s => new Date(s.startAt).toDateString()));
  let currentStreak = 0;
  let cursor = new Date();
  while (daysWithCompleted.has(cursor.toDateString())) {
    currentStreak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  // Longest streak ever, scanning the distinct days with a completed fast.
  const sortedDays = [...daysWithCompleted].map(d => new Date(d)).sort((a, b) => a - b);
  let longestStreak = 0, run = 0, prevDay = null;
  for (const d of sortedDays) {
    if (prevDay && (d - prevDay) / 86400000 === 1) run++;
    else run = 1;
    longestStreak = Math.max(longestStreak, run);
    prevDay = d;
  }

  res.json({
    totalFasts,
    longestFastHours: Math.round(longestFastHours * 10) / 10,
    avg7FastHours: Math.round(avg7 * 10) / 10,
    currentStreak, longestStreak
  });
});

// Water logging for tracker clients — keyed by calendar date, since they
// have no protocol "day" counter at all.
router.post('/tracker/water', requireActive, async (req, res) => {
  try {
    const { ml } = req.body;
    if (!ml || ml <= 0) return res.status(400).json({ error: 'ml must be a positive number' });
    const entry = await TrackerWaterEntry.create({ userId: req.user.id, ml });
    res.status(201).json({ entry });
  } catch (err) {
    res.status(500).json({ error: 'Could not log water', detail: err.message });
  }
});

router.get('/tracker/water', requireActive, async (req, res) => {
  const since = new Date(); since.setDate(since.getDate() - 9); since.setHours(0, 0, 0, 0);
  const entries = await TrackerWaterEntry.findAll({ where: { userId: req.user.id, at: { [Op.gte]: since } }, order: [['at', 'ASC']] });

  const byDate = {};
  for (const e of entries) {
    const key = new Date(e.at).toDateString();
    byDate[key] = (byDate[key] || 0) + e.ml;
  }
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    last7.push({ date: d.toDateString(), ml: byDate[d.toDateString()] || 0 });
  }
  const todayMl = byDate[new Date().toDateString()] || 0;

  res.json({ goalMl: req.user.waterGoalMl, todayMl, last7 });
});

router.delete('/tracker/water/:id', requireActive, async (req, res) => {
  const entry = await TrackerWaterEntry.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  await entry.destroy();
  res.json({ ok: true });
});

router.post('/tracker/water-goal', requireActive, async (req, res) => {
  const { goalMl } = req.body;
  if (!goalMl || goalMl <= 0) return res.status(400).json({ error: 'goalMl is required' });
  req.user.waterGoalMl = goalMl;
  await req.user.save();
  res.json({ goalMl: req.user.waterGoalMl });
});

/* ------------------------------------------------------------------ */
/* Today-page progress card — small motivational numbers, shared shape  */
/* whether the client is coached (streak/points) or on the tracker      */
/* (fasts/streak). Kept separate from /dashboard so it's cheap to poll. */
/* ------------------------------------------------------------------ */
router.get('/progress', requireActive, async (req, res) => {
  const user = req.user;
  if (user.planMode === 'tracker') {
    const sessions = await TrackerSession.findAll({ where: { userId: user.id, status: { [Op.in]: ['completed', 'broken'] } } });
    const completed = sessions.filter(s => s.status === 'completed');
    const daysWithCompleted = new Set(completed.map(s => new Date(s.startAt).toDateString()));
    let currentStreak = 0, cursor = new Date();
    while (daysWithCompleted.has(cursor.toDateString())) { currentStreak++; cursor.setDate(cursor.getDate() - 1); }
    const longestFastHours = sessions.length ? Math.max(...sessions.map(s => (new Date(s.endAt) - new Date(s.startAt)) / 3600000)) : 0;
    return res.json({ planMode: 'tracker', totalFasts: sessions.length, currentStreak, longestFastHours: Math.round(longestFastHours * 10) / 10 });
  }
  // Re-derive before reporting, so the strip can never show a stale
  // points total left behind by an older version of the scoring code.
  const day = user.currentChallengeDay();
  const score = await applyScoring(user, day);

  res.json({
    planMode: 'protocol',
    points: score.points,
    streakCurrent: score.streakCurrent,
    streakBest: score.streakBest,
    day,
    challengeLengthDays: user.challengeLengthDays,
    // today's checklist — drives the progress bar on the Today page
    todayPercent: score.percent,
    todayDone: score.done,
    todayTotal: score.total,
    todayScored: score.qualifies,
    threshold: COMPLETION_THRESHOLD,
    pointsPerDay: POINTS_PER_DAY
  });
});

/* ------------------------------------------------------------------ */
/* Alerts                                                                */
/* ------------------------------------------------------------------ */
router.get('/alerts', requireActive, async (req, res) => {
  const alerts = await Alert.findAll({
    where: { [Op.or]: [{ userId: null }, { userId: req.user.id }] },
    include: [{ model: AlertRead, where: { userId: req.user.id }, required: false }],
    order: [['createdAt', 'DESC']]
  });
  const unread = alerts.filter(a => !a.AlertReads || a.AlertReads.length === 0).length;
  res.json({ alerts, unread });
});

router.post('/alerts/:id/read', requireActive, async (req, res) => {
  const existing = await AlertRead.findOne({ where: { alertId: req.params.id, userId: req.user.id } });
  if (!existing) await AlertRead.create({ alertId: req.params.id, userId: req.user.id });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Chat (available even before activation)                              */
/* ------------------------------------------------------------------ */
router.get('/messages', async (req, res) => {
  const messages = await Message.findAll({ where: { clientId: req.user.id }, order: [['createdAt', 'ASC']] });
  await Message.update({ readByClient: true }, { where: { clientId: req.user.id, sender: 'admin' } });
  res.json({ messages });
});

router.post('/messages', async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });
  const message = await Message.create({ clientId: req.user.id, sender: 'client', body: body.trim() });
  res.status(201).json({ message });
});

/* ------------------------------------------------------------------ */
/* Contact us (available even before activation)                        */
/* ------------------------------------------------------------------ */
router.get('/contact', async (req, res) => {
  const settings = await Settings.getOrCreate();
  res.json({ settings });
});

module.exports = router;
