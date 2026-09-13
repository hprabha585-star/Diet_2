const express = require('express');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Regimen = require('../models/Regimen');
const ChecklistLog = require('../models/ChecklistLog');
const Payout = require('../models/Payout');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeFastingState } = require('../utils/helpers');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

const TIER_PRICES = { standard: 3999, vip: 9999 };

// POST /api/client/payments  — submit UPI proof to unlock access
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

// GET /api/client/dashboard — today's plan, fasting state, checklist
router.get('/dashboard', async (req, res) => {
  try {
    const user = req.user;
    if (user.status !== 'active') {
      return res.json({ status: user.status, message: 'Your account is not active yet. Waiting on payment approval.' });
    }
    const day = user.currentChallengeDay();
    const regimen = await Regimen.findOne({ user: user._id, day });
    let checklist = await ChecklistLog.findOne({ user: user._id, day });

    if (regimen && !checklist) {
      const items = [
        ...regimen.meals.map(m => ({ key: `meal_${m.type}`, label: m.name, done: false })),
        ...regimen.milestones.map(m => ({ key: m.key, label: m.label, done: false }))
      ];
      checklist = await ChecklistLog.create({ user: user._id, day, items, waterMl: 0 });
    }

    const fastingState = regimen ? computeFastingState(regimen.fastingWindow) : null;

    res.json({
      status: 'active',
      day,
      challengeLengthDays: user.challengeLengthDays,
      points: user.points,
      streakCurrent: user.streakCurrent,
      streakBest: user.streakBest,
      regimen,
      checklist,
      fastingState
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load dashboard', detail: err.message });
  }
});

// POST /api/client/checklist — toggle an item or log water
router.post('/checklist', async (req, res) => {
  try {
    const user = req.user;
    const day = user.currentChallengeDay();
    const { itemKey, done, addWaterMl } = req.body;

    const checklist = await ChecklistLog.findOne({ user: user._id, day });
    if (!checklist) return res.status(404).json({ error: 'No checklist found for today' });

    if (itemKey) {
      const item = checklist.items.find(i => i.key === itemKey);
      if (!item) return res.status(404).json({ error: 'Checklist item not found' });
      item.done = !!done;
    }
    if (addWaterMl) {
      checklist.waterMl += Number(addWaterMl);
    }

    const doneCount = checklist.items.filter(i => i.done).length;
    checklist.completionPercent = checklist.items.length
      ? Math.round((doneCount / checklist.items.length) * 100)
      : 0;

    // Award streak/points once per day when adherence crosses 80%
    if (checklist.completionPercent >= 80 && !checklist.streakCounted) {
      checklist.streakCounted = true;
      user.streakCurrent += 1;
      user.streakBest = Math.max(user.streakBest, user.streakCurrent);
      user.points += 100;
      await user.save();
    }

    await checklist.save();
    res.json({ checklist, points: user.points, streakCurrent: user.streakCurrent });
  } catch (err) {
    res.status(500).json({ error: 'Could not update checklist', detail: err.message });
  }
});

// POST /api/client/weight
router.post('/weight', async (req, res) => {
  try {
    const { weightKg } = req.body;
    if (!weightKg || weightKg <= 0) return res.status(400).json({ error: 'A valid weight is required' });
    req.user.weightLogs.push({ weightKg, date: new Date() });
    if (!req.user.startWeightKg) req.user.startWeightKg = weightKg;
    await req.user.save();
    res.json({ weightLogs: req.user.weightLogs });
  } catch (err) {
    res.status(500).json({ error: 'Could not log weight', detail: err.message });
  }
});

// GET /api/client/history
router.get('/history', async (req, res) => {
  const logs = await ChecklistLog.find({ user: req.user._id }).sort({ day: 1 });
  res.json({
    weightLogs: req.user.weightLogs,
    startWeightKg: req.user.startWeightKg,
    goalWeightKg: req.user.goalWeightKg,
    checklistHistory: logs.map(l => ({ day: l.day, date: l.date, completionPercent: l.completionPercent }))
  });
});

// GET /api/client/leaderboard
router.get('/leaderboard', async (req, res) => {
  const clients = await User.find({ role: 'client', status: 'active' })
    .sort({ points: -1, streakCurrent: -1 })
    .select('name points streakCurrent streakBest badges')
    .limit(50);
  res.json({ leaderboard: clients });
});

// GET /api/client/referral
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

// POST /api/client/payout-request
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
