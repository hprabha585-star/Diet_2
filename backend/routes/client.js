const express = require('express');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Regimen = require('../models/Regimen');
const ChecklistLog = require('../models/ChecklistLog');
const Payout = require('../models/Payout');
const ProtocolDay = require('../models/ProtocolDay');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeFastingState, buildChecklistItems } = require('../utils/helpers');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

const TIER_PRICES = { standard: 3999, vip: 9999 };

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */
router.post('/payments', async (req, res) => {
  try {
    const { tier, utr, screenshotBase64 } = req.body;
    if (!TIER_PRICES[tier]) return res.status(400).json({ error: 'Invalid tier' });
    if (!utr || utr.trim().length < 6) return res.status(400).json({ error: 'A valid UTR number is required' });

    const payment = await Payment.create({
      user: req.user._id, tier, amountInr: TIER_PRICES[tier], utr: utr.trim(), screenshotBase64
    });
    req.user.tier = tier;
    await req.user.save();
    res.status(201).json({ payment });
  } catch (err) {
    res.status(500).json({ error: 'Could not submit payment', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */
async function getTodayChecklist(user, day, regimen) {
  let checklist = await ChecklistLog.findOne({ user: user._id, day });
  if (regimen && !checklist) {
    checklist = await ChecklistLog.create({
      user: user._id, day, items: buildChecklistItems(regimen), waterEntries: [], waterMl: 0
    });
  }
  return checklist;
}

router.get('/dashboard', async (req, res) => {
  try {
    const user = req.user;
    if (user.status !== 'active') {
      return res.json({ status: user.status, message: 'Your account is not active yet. Waiting on payment approval.' });
    }
    const day = user.currentChallengeDay();
    const regimen = await Regimen.findOne({ user: user._id, day });
    const checklist = await getTodayChecklist(user, day, regimen);

    const paused = !!(user.fastingPause && user.fastingPause.active);
    const fastingState = regimen
      ? computeFastingState(regimen, { paused, reason: paused ? user.fastingPause.reason : '' })
      : null;

    // Last 14 days of adherence — powers the bar chart on the Today page.
    const recent = await ChecklistLog.find({ user: user._id }).sort({ day: -1 }).limit(14);
    const chart = recent.reverse().map(l => ({
      day: l.day,
      completionPercent: l.completionPercent,
      waterMl: l.waterMl
    }));

    res.json({
      status: 'active',
      day,
      challengeLengthDays: user.challengeLengthDays,
      points: user.points,
      streakCurrent: user.streakCurrent,
      streakBest: user.streakBest,
      fastingPause: user.fastingPause,
      pausedDays: user.pausedDays,
      regimen,
      checklist,
      fastingState,
      chart
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load dashboard', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Checklist — toggle, add, edit, delete                               */
/* ------------------------------------------------------------------ */

// Award points/streak the first time a day crosses 80% adherence.
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
  return {
    checklist,
    points: user.points,
    streakCurrent: user.streakCurrent,
    streakBest: user.streakBest
  };
}

// POST /api/client/checklist — toggle an item (kept for backwards compatibility)
router.post('/checklist', async (req, res) => {
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

// POST /api/client/checklist/items — add your own habit for today
router.post('/checklist/items', async (req, res) => {
  try {
    const user = req.user;
    const { label } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: 'A label is required' });

    const { day } = await loadTodayChecklist(user);
    let checklist = await ChecklistLog.findOne({ user: user._id, day });
    if (!checklist) {
      checklist = await ChecklistLog.create({ user: user._id, day, items: [], waterEntries: [] });
    }
    const key = `custom_${Date.now().toString(36)}`;
    checklist.items.push({ key, label: label.trim(), done: false, custom: true });
    checklist.recalcCompletion();
    await checklist.save();
    res.status(201).json(checklistResponse(checklist, user));
  } catch (err) {
    res.status(500).json({ error: 'Could not add item', detail: err.message });
  }
});

// PATCH /api/client/checklist/items/:key — rename or tick an item
router.patch('/checklist/items/:key', async (req, res) => {
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

// DELETE /api/client/checklist/items/:key
router.delete('/checklist/items/:key', async (req, res) => {
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

/* ------------------------------------------------------------------ */
/* Water — add, edit, delete individual entries                        */
/* ------------------------------------------------------------------ */
router.post('/water', async (req, res) => {
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

router.patch('/water/:entryId', async (req, res) => {
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

router.delete('/water/:entryId', async (req, res) => {
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

/* ------------------------------------------------------------------ */
/* Pause / resume fasting (illness, travel, medical advice)            */
/* ------------------------------------------------------------------ */
router.post('/fasting/pause', async (req, res) => {
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

router.post('/fasting/resume', async (req, res) => {
  try {
    const user = req.user;
    if (!user.fastingPause || !user.fastingPause.active) {
      return res.status(400).json({ error: 'Fasting is not paused' });
    }
    // Freeze the challenge clock for however long the pause lasted.
    const elapsedDays = Math.floor((Date.now() - new Date(user.fastingPause.startedAt).getTime()) / 86400000);
    user.pausedDays = (user.pausedDays || 0) + Math.max(0, elapsedDays);
    user.fastingPause = {
      active: false,
      reason: user.fastingPause.reason,
      startedAt: user.fastingPause.startedAt,
      lastResumedAt: new Date()
    };
    await user.save();
    res.json({ fastingPause: user.fastingPause, pausedDays: user.pausedDays, day: user.currentChallengeDay() });
  } catch (err) {
    res.status(500).json({ error: 'Could not resume fasting', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Weight + BMI                                                        */
/* ------------------------------------------------------------------ */
router.post('/weight', async (req, res) => {
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

router.patch('/weight/:logId', async (req, res) => {
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

router.delete('/weight/:logId', async (req, res) => {
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

// POST /api/client/profile — height / goal weight, used by the BMI calculator
router.post('/profile', async (req, res) => {
  try {
    const { heightCm, goalWeightKg, startWeightKg } = req.body;
    if (heightCm !== undefined) {
      const h = Number(heightCm);
      if (!h || h < 80 || h > 260) return res.status(400).json({ error: 'Enter a height between 80 and 260 cm' });
      req.user.heightCm = h;
    }
    if (goalWeightKg !== undefined) req.user.goalWeightKg = Number(goalWeightKg) || undefined;
    if (startWeightKg !== undefined) req.user.startWeightKg = Number(startWeightKg) || undefined;
    await req.user.save();
    res.json({ user: req.user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Could not save profile', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* History / leaderboard / referral                                    */
/* ------------------------------------------------------------------ */
router.get('/history', async (req, res) => {
  const logs = await ChecklistLog.find({ user: req.user._id }).sort({ day: 1 });
  res.json({
    weightLogs: req.user.weightLogs,
    startWeightKg: req.user.startWeightKg,
    goalWeightKg: req.user.goalWeightKg,
    heightCm: req.user.heightCm,
    bmi: req.user.bmi(),
    checklistHistory: logs.map(l => ({ day: l.day, date: l.date, completionPercent: l.completionPercent, waterMl: l.waterMl }))
  });
});

router.get('/leaderboard', async (req, res) => {
  const clients = await User.find({ role: 'client', status: 'active' })
    .sort({ points: -1, streakCurrent: -1 })
    .select('name points streakCurrent streakBest badges')
    .limit(50);
  res.json({ leaderboard: clients });
});

// GET /api/client/protocol — read-only view of the master 55-day protocol
router.get('/protocol', async (req, res) => {
  const days = await ProtocolDay.find({}).sort({ day: 1 });
  res.json({ days, currentDay: req.user.currentChallengeDay() });
});

router.get('/referral', async (req, res) => {
  const referredCount = await User.countDocuments({ referredBy: req.user._id });
  const payouts = await Payout.find({ user: req.user._id }).sort({ requestedAt: -1 });
  res.json({
    referralCode: req.user.referralCode,
    walletBalanceInr: req.user.walletBalanceInr,
    referredCount,
    payouts
  });
});

router.post('/payout-request', async (req, res) => {
  try {
    const { upiId } = req.body;
    if (!upiId) return res.status(400).json({ error: 'UPI ID is required' });
    if (req.user.walletBalanceInr < 500) {
      return res.status(400).json({ error: 'Minimum payout balance is ₹500' });
    }
    const payout = await Payout.create({
      user: req.user._id, amountInr: req.user.walletBalanceInr, upiId
    });
    res.status(201).json({ payout });
  } catch (err) {
    res.status(500).json({ error: 'Could not request payout', detail: err.message });
  }
});

module.exports = router;
