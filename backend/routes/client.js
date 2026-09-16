const express = require('express');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Regimen = require('../models/Regimen');
const ChecklistLog = require('../models/ChecklistLog');
const Payout = require('../models/Payout');
const ProtocolDay = require('../models/ProtocolDay');
const Plan = require('../models/Plan');
const Alert = require('../models/Alert');
const Message = require('../models/Message');
const Settings = require('../models/Settings');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeFastingState, buildChecklistItems } = require('../utils/helpers');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

// Everything except payment, plans, contact, alerts and profile is locked
// until the coach approves the client's payment.
function requireActive(req, res, next) {
  if (req.user.status !== 'active') {
    return res.status(403).json({
      error: 'Your account is not active yet. Submit your payment and wait for your coach to approve it.',
      status: req.user.status
    });
  }
  next();
}

/* ------------------------------------------------------------------ */
/* Plans & payments (always available)                                 */
/* ------------------------------------------------------------------ */
async function activePlans() {
  let plans = await Plan.find({ active: true }).sort({ order: 1, priceInr: 1 });
  if (!plans.length) {
    await Plan.insertMany(Plan.DEFAULTS);
    plans = await Plan.find({ active: true }).sort({ order: 1, priceInr: 1 });
  }
  return plans;
}

router.get('/plans', async (req, res) => {
  res.json({ plans: await activePlans() });
});

router.post('/payments', async (req, res) => {
  try {
    const { tier, utr, screenshotBase64 } = req.body;
    const plan = await Plan.findOne({ key: (tier || '').toLowerCase(), active: true });
    if (!plan) return res.status(400).json({ error: 'Pick one of the available plans' });
    if (!utr || utr.trim().length < 6) return res.status(400).json({ error: 'A valid UTR number is required' });

    const payment = await Payment.create({
      user: req.user._id, tier: plan.key, planName: plan.name,
      amountInr: plan.priceInr, utr: utr.trim(), screenshotBase64
    });
    req.user.tier = plan.key;
    req.user.challengeLengthDays = plan.durationDays || req.user.challengeLengthDays;
    await req.user.save();
    res.status(201).json({ payment });
  } catch (err) {
    res.status(500).json({ error: 'Could not submit payment', detail: err.message });
  }
});

// GET /api/client/payments — so the client can see where their submission stands
router.get('/payments', async (req, res) => {
  const payments = await Payment.find({ user: req.user._id })
    .select('-screenshotBase64')
    .sort({ createdAt: -1 });
  res.json({ payments, status: req.user.status });
});

/* ------------------------------------------------------------------ */
/* Contact details + alerts + chat (available before activation too)   */
/* ------------------------------------------------------------------ */
router.get('/contact', async (req, res) => {
  const s = await Settings.getOrCreate();
  res.json({
    contact: {
      coachName: s.coachName, phone: s.phone, whatsapp: s.whatsapp, email: s.email,
      upiId: s.upiId, address: s.address, supportHours: s.supportHours, note: s.note
    }
  });
});

router.get('/alerts', async (req, res) => {
  const alerts = await Alert.find({ $or: [{ user: req.user._id }, { user: null }] })
    .sort({ createdAt: -1 }).limit(50);
  const unread = alerts.filter(a => !a.readBy.some(id => String(id) === String(req.user._id))).length;
  res.json({
    alerts: alerts.map(a => ({
      _id: a._id, title: a.title, body: a.body, level: a.level, createdAt: a.createdAt,
      forEveryone: !a.user,
      read: a.readBy.some(id => String(id) === String(req.user._id))
    })),
    unread
  });
});

router.post('/alerts/:id/read', async (req, res) => {
  await Alert.updateOne({ _id: req.params.id }, { $addToSet: { readBy: req.user._id } });
  res.json({ ok: true });
});

router.post('/alerts/read-all', async (req, res) => {
  await Alert.updateMany({ $or: [{ user: req.user._id }, { user: null }] },
    { $addToSet: { readBy: req.user._id } });
  res.json({ ok: true });
});

router.get('/messages', async (req, res) => {
  const messages = await Message.find({ client: req.user._id }).sort({ createdAt: 1 }).limit(300);
  await Message.updateMany({ client: req.user._id, sender: 'admin', readByClient: false }, { readByClient: true });
  res.json({ messages });
});

router.get('/messages/unread', async (req, res) => {
  const unread = await Message.countDocuments({ client: req.user._id, sender: 'admin', readByClient: false });
  res.json({ unread });
});

router.post('/messages', async (req, res) => {
  try {
    const body = (req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Type a message first' });
    const message = await Message.create({
      client: req.user._id, sender: 'client', body, readByClient: true, readByAdmin: false
    });
    res.status(201).json({ message });
  } catch (err) {
    res.status(500).json({ error: 'Could not send message', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Profile (height / age / gender for the BMI tool)                    */
/* ------------------------------------------------------------------ */
router.post('/profile', async (req, res) => {
  try {
    const { heightCm, age, gender } = req.body;
    if (heightCm !== undefined) {
      const h = Number(heightCm);
      if (!h || h < 80 || h > 260) return res.status(400).json({ error: 'Enter a height between 80 and 260 cm' });
      req.user.heightCm = h;
    }
    if (age !== undefined && age !== '') {
      const a = Number(age);
      if (!a || a < 2 || a > 120) return res.status(400).json({ error: 'Enter an age between 2 and 120' });
      req.user.age = a;
    }
    if (gender !== undefined) req.user.gender = ['female', 'male', 'other'].includes(gender) ? gender : '';
    await req.user.save();
    res.json({ user: req.user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Could not save profile', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Everything below needs an approved payment                          */
/* ------------------------------------------------------------------ */

// Keep today's checklist in step with whatever the coach has assigned:
// new meals/habits are added, removed ones disappear, ticks are preserved,
// and anything the client added themselves is left alone.
async function syncChecklist(user, day, regimen) {
  let checklist = await ChecklistLog.findOne({ user: user._id, day });
  if (!regimen) return checklist;

  const planned = buildChecklistItems(regimen);
  if (!checklist) {
    return ChecklistLog.create({ user: user._id, day, items: planned, waterEntries: [], waterMl: 0 });
  }

  const byKey = new Map(checklist.items.map(i => [i.key, i]));
  const merged = planned.map(p => {
    const existing = byKey.get(p.key);
    return { key: p.key, label: p.label, done: existing ? existing.done : false, custom: false };
  });
  // keep the client's own habits at the end
  merged.push(...checklist.items.filter(i => i.custom));

  const changed =
    merged.length !== checklist.items.length ||
    merged.some((m, i) => !checklist.items[i] || checklist.items[i].key !== m.key || checklist.items[i].label !== m.label);

  if (changed) {
    checklist.items = merged;
    checklist.recalcCompletion();
    await checklist.save();
  }
  return checklist;
}

router.get('/dashboard', async (req, res) => {
  try {
    const user = req.user;
    if (user.status !== 'active') {
      const payments = await Payment.find({ user: user._id }).select('-screenshotBase64').sort({ createdAt: -1 });
      return res.json({
        status: user.status,
        locked: true,
        payments,
        message: 'Your account is not active yet. Waiting on payment approval.'
      });
    }
    const day = user.currentChallengeDay();
    const regimen = await Regimen.findOne({ user: user._id, day });
    const checklist = await syncChecklist(user, day, regimen);

    const paused = !!(user.fastingPause && user.fastingPause.active);
    const fastingState = regimen
      ? computeFastingState(regimen, { paused, reason: paused ? user.fastingPause.reason : '' })
      : null;

    const recent = await ChecklistLog.find({ user: user._id }).sort({ day: -1 }).limit(14);
    const chart = recent.reverse().map(l => ({ day: l.day, completionPercent: l.completionPercent, waterMl: l.waterMl }));

    const [unreadAlerts, unreadMessages] = await Promise.all([
      Alert.countDocuments({ $or: [{ user: user._id }, { user: null }], readBy: { $ne: user._id } }),
      Message.countDocuments({ client: user._id, sender: 'admin', readByClient: false })
    ]);

    res.json({
      status: 'active',
      locked: false,
      day,
      challengeLengthDays: user.challengeLengthDays,
      points: user.points,
      streakCurrent: user.streakCurrent,
      streakBest: user.streakBest,
      fastingPause: user.fastingPause,
      pausedDays: user.pausedDays,
      profile: { heightCm: user.heightCm, age: user.age, gender: user.gender },
      regimen,
      checklist,
      fastingState,
      chart,
      unreadAlerts,
      unreadMessages
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load dashboard', detail: err.message });
  }
});

/* ---------------- Checklist ---------------- */
async function applyStreak(user, checklist) {
  if (checklist.completionPercent >= 80 && !checklist.streakCounted) {
    checklist.streakCounted = true;
    user.streakCurrent += 1;
    user.streakBest = Math.max(user.streakBest, user.streakCurrent);
    user.points += 100;
    await user.save();
  }
}

async function loadTodayChecklist(user) {
  const day = user.currentChallengeDay();
  const checklist = await ChecklistLog.findOne({ user: user._id, day });
  return { day, checklist };
}

function checklistResponse(checklist, user) {
  return { checklist, points: user.points, streakCurrent: user.streakCurrent, streakBest: user.streakBest };
}

router.post('/checklist', requireActive, async (req, res) => {
  try {
    const user = req.user;
    const { checklist } = await loadTodayChecklist(user);
    if (!checklist) return res.status(404).json({ error: 'No checklist found for today' });

    const { itemKey, done, addWaterMl } = req.body;
    if (itemKey) {
      const item = checklist.items.find(i => i.key === itemKey);
      if (!item) return res.status(404).json({ error: 'Checklist item not found' });
      item.done = !!done;
    }
    if (addWaterMl) {
      checklist.waterEntries.push({ ml: Number(addWaterMl), at: new Date() });
      checklist.recalcWater();
    }
    checklist.recalcCompletion();
    await applyStreak(user, checklist);
    await checklist.save();
    res.json(checklistResponse(checklist, user));
  } catch (err) {
    res.status(500).json({ error: 'Could not update checklist', detail: err.message });
  }
});

router.post('/checklist/items', requireActive, async (req, res) => {
  try {
    const user = req.user;
    const label = (req.body.label || '').trim();
    if (!label) return res.status(400).json({ error: 'A label is required' });

    const day = user.currentChallengeDay();
    let checklist = await ChecklistLog.findOne({ user: user._id, day });
    if (!checklist) checklist = await ChecklistLog.create({ user: user._id, day, items: [], waterEntries: [] });

    checklist.items.push({ key: `custom_${Date.now().toString(36)}`, label, done: false, custom: true });
    checklist.recalcCompletion();
    await checklist.save();
    res.status(201).json(checklistResponse(checklist, user));
  } catch (err) {
    res.status(500).json({ error: 'Could not add item', detail: err.message });
  }
});

router.patch('/checklist/items/:key', requireActive, async (req, res) => {
  try {
    const user = req.user;
    const { checklist } = await loadTodayChecklist(user);
    if (!checklist) return res.status(404).json({ error: 'No checklist found for today' });
    const item = checklist.items.find(i => i.key === req.params.key);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });

    if (typeof req.body.label === 'string' && req.body.label.trim()) item.label = req.body.label.trim();
    if (typeof req.body.done === 'boolean') item.done = req.body.done;

    checklist.recalcCompletion();
    await applyStreak(user, checklist);
    await checklist.save();
    res.json(checklistResponse(checklist, user));
  } catch (err) {
    res.status(500).json({ error: 'Could not update item', detail: err.message });
  }
});

router.delete('/checklist/items/:key', requireActive, async (req, res) => {
  try {
    const user = req.user;
    const { checklist } = await loadTodayChecklist(user);
    if (!checklist) return res.status(404).json({ error: 'No checklist found for today' });
    const before = checklist.items.length;
    checklist.items = checklist.items.filter(i => i.key !== req.params.key);
    if (checklist.items.length === before) return res.status(404).json({ error: 'Checklist item not found' });
    checklist.recalcCompletion();
    await checklist.save();
    res.json(checklistResponse(checklist, user));
  } catch (err) {
    res.status(500).json({ error: 'Could not delete item', detail: err.message });
  }
});

/* ---------------- Water ---------------- */
router.post('/water', requireActive, async (req, res) => {
  try {
    const user = req.user;
    const ml = Number(req.body.ml);
    if (!ml || ml <= 0) return res.status(400).json({ error: 'A positive amount is required' });
    const day = user.currentChallengeDay();
    let checklist = await ChecklistLog.findOne({ user: user._id, day });
    if (!checklist) checklist = await ChecklistLog.create({ user: user._id, day, items: [], waterEntries: [] });
    checklist.waterEntries.push({ ml, at: new Date() });
    checklist.recalcWater();
    await checklist.save();
    res.status(201).json({ checklist });
  } catch (err) {
    res.status(500).json({ error: 'Could not log water', detail: err.message });
  }
});

router.patch('/water/:entryId', requireActive, async (req, res) => {
  try {
    const { checklist } = await loadTodayChecklist(req.user);
    if (!checklist) return res.status(404).json({ error: 'No checklist found for today' });
    const entry = checklist.waterEntries.id(req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Water entry not found' });
    const ml = Number(req.body.ml);
    if (!ml || ml <= 0) return res.status(400).json({ error: 'A positive amount is required' });
    entry.ml = ml;
    checklist.recalcWater();
    await checklist.save();
    res.json({ checklist });
  } catch (err) {
    res.status(500).json({ error: 'Could not update water entry', detail: err.message });
  }
});

router.delete('/water/:entryId', requireActive, async (req, res) => {
  try {
    const { checklist } = await loadTodayChecklist(req.user);
    if (!checklist) return res.status(404).json({ error: 'No checklist found for today' });
    const entry = checklist.waterEntries.id(req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Water entry not found' });
    entry.deleteOne();
    checklist.recalcWater();
    await checklist.save();
    res.json({ checklist });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete water entry', detail: err.message });
  }
});

/* ---------------- Pause / resume ---------------- */
router.post('/fasting/pause', requireActive, async (req, res) => {
  try {
    const user = req.user;
    if (user.fastingPause && user.fastingPause.active) {
      return res.status(400).json({ error: 'Fasting is already paused' });
    }
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Please tell your coach why you are pausing' });
    user.fastingPause = { active: true, reason, startedAt: new Date(), lastResumedAt: user.fastingPause?.lastResumedAt };
    await user.save();
    res.json({ fastingPause: user.fastingPause, day: user.currentChallengeDay() });
  } catch (err) {
    res.status(500).json({ error: 'Could not pause fasting', detail: err.message });
  }
});

router.post('/fasting/resume', requireActive, async (req, res) => {
  try {
    const user = req.user;
    if (!user.fastingPause || !user.fastingPause.active) {
      return res.status(400).json({ error: 'Fasting is not paused' });
    }
    const elapsedDays = Math.floor((Date.now() - new Date(user.fastingPause.startedAt).getTime()) / 86400000);
    user.pausedDays = (user.pausedDays || 0) + Math.max(0, elapsedDays);
    user.fastingPause = {
      active: false, reason: user.fastingPause.reason,
      startedAt: user.fastingPause.startedAt, lastResumedAt: new Date()
    };
    await user.save();
    res.json({ fastingPause: user.fastingPause, pausedDays: user.pausedDays, day: user.currentChallengeDay() });
  } catch (err) {
    res.status(500).json({ error: 'Could not resume fasting', detail: err.message });
  }
});

/* ---------------- Weight ---------------- */
router.post('/weight', requireActive, async (req, res) => {
  try {
    const { weightKg, note } = req.body;
    if (!weightKg || weightKg <= 0) return res.status(400).json({ error: 'A valid weight is required' });
    req.user.weightLogs.push({ weightKg, note, date: new Date() });
    if (!req.user.startWeightKg) req.user.startWeightKg = weightKg;
    await req.user.save();
    res.json({ weightLogs: req.user.weightLogs, bmi: req.user.bmi() });
  } catch (err) {
    res.status(500).json({ error: 'Could not log weight', detail: err.message });
  }
});

router.patch('/weight/:logId', requireActive, async (req, res) => {
  try {
    const log = req.user.weightLogs.id(req.params.logId);
    if (!log) return res.status(404).json({ error: 'Weight entry not found' });
    const { weightKg, date, note } = req.body;
    if (weightKg !== undefined) {
      if (!weightKg || weightKg <= 0) return res.status(400).json({ error: 'A valid weight is required' });
      log.weightKg = weightKg;
    }
    if (date) log.date = new Date(date);
    if (note !== undefined) log.note = note;
    await req.user.save();
    res.json({ weightLogs: req.user.weightLogs, bmi: req.user.bmi() });
  } catch (err) {
    res.status(500).json({ error: 'Could not update weight entry', detail: err.message });
  }
});

router.delete('/weight/:logId', requireActive, async (req, res) => {
  try {
    const log = req.user.weightLogs.id(req.params.logId);
    if (!log) return res.status(404).json({ error: 'Weight entry not found' });
    log.deleteOne();
    await req.user.save();
    res.json({ weightLogs: req.user.weightLogs, bmi: req.user.bmi() });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete weight entry', detail: err.message });
  }
});

/* ---------------- History / leaderboard / protocol / referral ---------------- */
router.get('/history', requireActive, async (req, res) => {
  const logs = await ChecklistLog.find({ user: req.user._id }).sort({ day: 1 });
  res.json({
    weightLogs: req.user.weightLogs,
    startWeightKg: req.user.startWeightKg,
    heightCm: req.user.heightCm,
    age: req.user.age,
    gender: req.user.gender,
    bmi: req.user.bmi(),
    healthyWeightRange: req.user.healthyWeightRange(),
    checklistHistory: logs.map(l => ({ day: l.day, date: l.date, completionPercent: l.completionPercent, waterMl: l.waterMl }))
  });
});

router.get('/leaderboard', requireActive, async (req, res) => {
  const clients = await User.find({ role: 'client', status: 'active' })
    .sort({ points: -1, streakCurrent: -1 })
    .select('name points streakCurrent streakBest badges')
    .limit(50);
  res.json({ leaderboard: clients });
});

router.get('/protocol', requireActive, async (req, res) => {
  const days = await ProtocolDay.find({}).sort({ day: 1 });
  res.json({ days, currentDay: req.user.currentChallengeDay() });
});

router.get('/referral', requireActive, async (req, res) => {
  const referredCount = await User.countDocuments({ referredBy: req.user._id });
  const payouts = await Payout.find({ user: req.user._id }).sort({ requestedAt: -1 });
  res.json({
    referralCode: req.user.referralCode,
    walletBalanceInr: req.user.walletBalanceInr,
    referredCount,
    payouts
  });
});

router.post('/payout-request', requireActive, async (req, res) => {
  try {
    const { upiId } = req.body;
    if (!upiId) return res.status(400).json({ error: 'UPI ID is required' });
    if (req.user.walletBalanceInr < 500) {
      return res.status(400).json({ error: 'Minimum payout balance is ₹500' });
    }
    const payout = await Payout.create({ user: req.user._id, amountInr: req.user.walletBalanceInr, upiId });
    res.status(201).json({ payout });
  } catch (err) {
    res.status(500).json({ error: 'Could not request payout', detail: err.message });
  }
});

module.exports = router;
