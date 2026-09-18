const express = require('express');
const {
  User, WeightLog, Plan, Payment, Payout,
  Regimen, RegimenMeal, RegimenMilestone,
  ChecklistLog, ChecklistItem, WaterEntry,
  Alert, AlertRead, Message, Settings, TrackerSession
} = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildChecklistItems, recalcCompletion } = require('../utils/helpers');
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
  const completion = recalcCompletion(log.items);
  if (completion !== log.completionPercent) {
    log.completionPercent = completion;
    await log.save();
  }

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
      waterTargetMl: regimen.waterTargetMl
    } : null,
    checklist: {
      meals: log.items.filter(i => i.kind === 'meal'),
      habits: log.items.filter(i => i.kind === 'habit'),
      completionPercent: log.completionPercent,
      waterMl: log.waterMl,
      waterEntries: log.waterEntries
    }
  });
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

    item.done = !!done;
    await item.save();

    const log = await getOrCreateChecklistLog(req.user.id, item.ChecklistLog.day);
    const completion = recalcCompletion(log.items);
    const crossedThreshold = completion >= 80 && log.completionPercent < 80 && !log.streakCounted;
    log.completionPercent = completion;

    let awardedPoints = false;
    if (crossedThreshold) {
      log.streakCounted = true;
      req.user.points += 100;
      req.user.streakCurrent += 1;
      if (req.user.streakCurrent > req.user.streakBest) req.user.streakBest = req.user.streakCurrent;
      await req.user.save();
      awardedPoints = true;
    }
    await log.save();

    res.json({ item, completionPercent: log.completionPercent, awardedPoints });
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
    const log = await WeightLog.create({ userId: req.user.id, weightKg, note });
    res.status(201).json({ log, bmi: req.user.bmi(weightKg), healthyWeightRange: req.user.healthyWeightRange() });
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
