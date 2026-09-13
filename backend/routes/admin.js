const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Regimen = require('../models/Regimen');
const ChecklistLog = require('../models/ChecklistLog');
const Payout = require('../models/Payout');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeFastingState, generateReferralCode } = require('../utils/helpers');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// POST /api/admin/clients — coach creates a client account directly.
// Always goes through bcrypt here, so credentials are guaranteed to work at
// login. Use this instead of adding documents to MongoDB by hand.
router.post('/clients', async (req, res) => {
  try {
    const { name, email, phone, password, tier, activateNow } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    let code;
    do {
      code = generateReferralCode(name);
    } while (await User.findOne({ referralCode: code }));

    const passwordHash = await bcrypt.hash(password, 10);
    const client = await User.create({
      name, email: email.toLowerCase(), phone, passwordHash,
      role: 'client', referralCode: code,
      tier: tier || 'none',
      status: activateNow ? 'active' : 'pending_payment',
      challengeStartDate: activateNow ? new Date() : undefined
    });
    res.status(201).json({ client: client.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Could not create client', detail: err.message });
  }
});

// POST /api/admin/clients/:id/reset-password — set a fresh, correctly
// hashed password for a client (e.g. if they're locked out).
router.post('/clients/:id/reset-password', async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const client = await User.findById(req.params.id);
    if (!client || client.role !== 'client') return res.status(404).json({ error: 'Client not found' });

    client.passwordHash = await bcrypt.hash(newPassword, 10);
    await client.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not reset password', detail: err.message });
  }
});

// GET /api/admin/clients — full roster with live status
router.get('/clients', async (req, res) => {
  const clients = await User.find({ role: 'client' }).sort({ createdAt: -1 });

  const enriched = await Promise.all(clients.map(async (c) => {
    const day = c.currentChallengeDay();
    const [regimen, checklist] = await Promise.all([
      Regimen.findOne({ user: c._id, day }),
      ChecklistLog.findOne({ user: c._id, day })
    ]);
    return {
      _id: c._id, name: c.name, email: c.email, phone: c.phone,
      tier: c.tier, status: c.status, day, challengeLengthDays: c.challengeLengthDays,
      points: c.points, streakCurrent: c.streakCurrent,
      waterMl: checklist ? checklist.waterMl : 0,
      completionPercent: checklist ? checklist.completionPercent : 0,
      fastingState: regimen ? computeFastingState(regimen.fastingWindow) : null,
      hasRegimenToday: !!regimen
    };
  }));

  res.json({ clients: enriched });
});

// GET /api/admin/clients/:id — single client detail
router.get('/clients/:id', async (req, res) => {
  const client = await User.findById(req.params.id);
  if (!client || client.role !== 'client') return res.status(404).json({ error: 'Client not found' });
  const regimens = await Regimen.find({ user: client._id }).sort({ day: 1 });
  const checklists = await ChecklistLog.find({ user: client._id }).sort({ day: 1 });
  res.json({ client: client.toSafeJSON(), regimens, checklists });
});

// POST /api/admin/clients/:id/activate — manually activate without payment (optional coach override)
router.post('/clients/:id/activate', async (req, res) => {
  const client = await User.findById(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  client.status = 'active';
  if (!client.challengeStartDate) client.challengeStartDate = new Date();
  await client.save();
  res.json({ client: client.toSafeJSON() });
});

// POST /api/admin/clients/:id/regimen — assign/update a day's plan
router.post('/clients/:id/regimen', async (req, res) => {
  try {
    const { day, fastingWindow, meals, milestones, waterTargetMl } = req.body;
    if (!day || !fastingWindow) return res.status(400).json({ error: 'day and fastingWindow are required' });

    const regimen = await Regimen.findOneAndUpdate(
      { user: req.params.id, day },
      { user: req.params.id, day, fastingWindow, meals: meals || [], milestones: milestones || [], waterTargetMl: waterTargetMl || 3000 },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ regimen });
  } catch (err) {
    res.status(500).json({ error: 'Could not save regimen', detail: err.message });
  }
});

// GET /api/admin/payments — pending queue (default) or all
router.get('/payments', async (req, res) => {
  const filter = req.query.status ? { status: req.query.status } : { status: 'pending' };
  const payments = await Payment.find(filter).populate('user', 'name email phone').sort({ createdAt: -1 });
  res.json({ payments });
});

// POST /api/admin/payments/:id/approve
router.post('/payments/:id/approve', async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  payment.status = 'approved';
  payment.reviewedBy = req.user._id;
  payment.reviewedAt = new Date();
  await payment.save();

  const client = await User.findById(payment.user);
  client.status = 'active';
  client.tier = payment.tier;
  if (!client.challengeStartDate) client.challengeStartDate = new Date();

  // Credit referrer ₹500 on first approved payment
  if (client.referredBy) {
    const alreadyRewarded = await Payment.countDocuments({ user: client._id, status: 'approved' });
    if (alreadyRewarded === 1) {
      const referrer = await User.findById(client.referredBy);
      if (referrer) {
        referrer.walletBalanceInr += 500;
        await referrer.save();
      }
    }
  }
  await client.save();

  res.json({ payment, client: client.toSafeJSON() });
});

// POST /api/admin/payments/:id/reject
router.post('/payments/:id/reject', async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  payment.status = 'rejected';
  payment.reviewedBy = req.user._id;
  payment.reviewedAt = new Date();
  payment.adminNote = req.body.note || '';
  await payment.save();
  res.json({ payment });
});

// GET /api/admin/leaderboard
router.get('/leaderboard', async (req, res) => {
  const clients = await User.find({ role: 'client', status: 'active' })
    .sort({ points: -1, streakCurrent: -1 })
    .select('name points streakCurrent streakBest tier');
  res.json({ leaderboard: clients });
});

// GET /api/admin/payouts
router.get('/payouts', async (req, res) => {
  const filter = req.query.status ? { status: req.query.status } : { status: 'pending' };
  const payouts = await Payout.find(filter).populate('user', 'name email').sort({ requestedAt: -1 });
  res.json({ payouts });
});

// POST /api/admin/payouts/:id/approve
router.post('/payouts/:id/approve', async (req, res) => {
  const payout = await Payout.findById(req.params.id);
  if (!payout) return res.status(404).json({ error: 'Payout not found' });
  const client = await User.findById(payout.user);

  payout.status = 'paid';
  payout.resolvedAt = new Date();
  payout.resolvedBy = req.user._id;
  await payout.save();

  client.walletBalanceInr -= payout.amountInr;
  await client.save();

  res.json({ payout });
});

// POST /api/admin/payouts/:id/reject
router.post('/payouts/:id/reject', async (req, res) => {
  const payout = await Payout.findById(req.params.id);
  if (!payout) return res.status(404).json({ error: 'Payout not found' });
  payout.status = 'rejected';
  payout.resolvedAt = new Date();
  payout.resolvedBy = req.user._id;
  await payout.save();
  res.json({ payout });
});

module.exports = router;
