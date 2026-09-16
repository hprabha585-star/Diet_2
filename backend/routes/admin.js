const express = require('express');
const bcrypt = require('bcryptjs');
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
const { computeFastingState, generateReferralCode } = require('../utils/helpers');
const { PROTOCOL_DAYS, SAFETY_NOTES } = require('../utils/protocolData');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

/* ------------------------------------------------------------------ */
/* Clients                                                             */
/* ------------------------------------------------------------------ */
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

router.get('/clients', async (req, res) => {
  const clients = await User.find({ role: 'client' }).sort({ createdAt: -1 });

  const enriched = await Promise.all(clients.map(async (c) => {
    const day = c.currentChallengeDay();
    const [regimen, checklist] = await Promise.all([
      Regimen.findOne({ user: c._id, day }),
      ChecklistLog.findOne({ user: c._id, day })
    ]);
    const paused = !!(c.fastingPause && c.fastingPause.active);
    return {
      _id: c._id, name: c.name, email: c.email, phone: c.phone,
      tier: c.tier, status: c.status, day, challengeLengthDays: c.challengeLengthDays,
      points: c.points, streakCurrent: c.streakCurrent,
      waterMl: checklist ? checklist.waterMl : 0,
      completionPercent: checklist ? checklist.completionPercent : 0,
      fastingState: regimen ? computeFastingState(regimen, { paused, reason: paused ? c.fastingPause.reason : '' }) : null,
      paused,
      pauseReason: paused ? c.fastingPause.reason : '',
      pausedDays: c.pausedDays || 0,
      heightCm: c.heightCm,
      bmi: c.bmi(),
      hasRegimenToday: !!regimen
    };
  }));

  res.json({ clients: enriched });
});

router.get('/clients/:id', async (req, res) => {
  const client = await User.findById(req.params.id);
  if (!client || client.role !== 'client') return res.status(404).json({ error: 'Client not found' });
  const regimens = await Regimen.find({ user: client._id }).sort({ day: 1 });
  const checklists = await ChecklistLog.find({ user: client._id }).sort({ day: 1 });
  res.json({ client: client.toSafeJSON(), regimens, checklists });
});

router.post('/clients/:id/activate', async (req, res) => {
  const client = await User.findById(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  client.status = 'active';
  if (!client.challengeStartDate) client.challengeStartDate = new Date();
  await client.save();
  res.json({ client: client.toSafeJSON() });
});

// POST /api/admin/clients/:id/pause — coach can pause or resume on a client's behalf
router.post('/clients/:id/pause', async (req, res) => {
  try {
    const client = await User.findById(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const active = !!req.body.active;

    if (active) {
      client.fastingPause = {
        active: true,
        reason: (req.body.reason || 'Paused by coach').trim(),
        startedAt: new Date(),
        lastResumedAt: client.fastingPause?.lastResumedAt
      };
    } else if (client.fastingPause && client.fastingPause.active) {
      const elapsed = Math.floor((Date.now() - new Date(client.fastingPause.startedAt).getTime()) / 86400000);
      client.pausedDays = (client.pausedDays || 0) + Math.max(0, elapsed);
      client.fastingPause = {
        active: false,
        reason: client.fastingPause.reason,
        startedAt: client.fastingPause.startedAt,
        lastResumedAt: new Date()
      };
    }
    await client.save();
    res.json({ fastingPause: client.fastingPause, pausedDays: client.pausedDays });
  } catch (err) {
    res.status(500).json({ error: 'Could not update pause state', detail: err.message });
  }
});

router.post('/clients/:id/regimen', async (req, res) => {
  try {
    const { day, fastingWindow, meals, milestones, waterTargetMl, isFullDayFast, protocolType, phase, focus } = req.body;
    if (!day || !fastingWindow) return res.status(400).json({ error: 'day and fastingWindow are required' });

    const regimen = await Regimen.findOneAndUpdate(
      { user: req.params.id, day },
      {
        user: req.params.id, day, fastingWindow,
        meals: meals || [], milestones: milestones || [],
        waterTargetMl: waterTargetMl || 3000,
        isFullDayFast: !!isFullDayFast,
        protocolType: protocolType || 'eating_window',
        phase: phase || '', focus: focus || ''
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ regimen });
  } catch (err) {
    res.status(500).json({ error: 'Could not save regimen', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* 55-day master protocol                                              */
/* ------------------------------------------------------------------ */

// GET /api/admin/protocol
router.get('/protocol', async (req, res) => {
  const days = await ProtocolDay.find({}).sort({ day: 1 });
  res.json({ days, safetyNotes: SAFETY_NOTES, seeded: days.length > 0 });
});

// POST /api/admin/protocol/seed  { force: true } to reset coach edits
router.post('/protocol/seed', async (req, res) => {
  try {
    const force = !!req.body.force;
    let inserted = 0, updated = 0;
    for (const d of PROTOCOL_DAYS) {
      const existing = await ProtocolDay.findOne({ day: d.day });
      if (!existing) { await ProtocolDay.create({ ...d, updatedAt: new Date() }); inserted++; }
      else if (force) { await ProtocolDay.updateOne({ day: d.day }, { ...d, updatedAt: new Date() }); updated++; }
    }
    const days = await ProtocolDay.find({}).sort({ day: 1 });
    res.json({ inserted, updated, days });
  } catch (err) {
    res.status(500).json({ error: 'Could not seed protocol', detail: err.message });
  }
});

// PUT /api/admin/protocol/:day — edit any day of the protocol
router.put('/protocol/:day', async (req, res) => {
  try {
    const day = parseInt(req.params.day, 10);
    if (!day || day < 1) return res.status(400).json({ error: 'Invalid day' });

    const { phase, protocolType, label, startHour, endHour, isFullDayFast, focus, waterTargetMl } = req.body;
    const fullFast = !!isFullDayFast;
    const start = Number(startHour);
    const end = Number(endHour);
    if (!fullFast && (isNaN(start) || isNaN(end))) {
      return res.status(400).json({ error: 'Eating window start and end are required' });
    }
    const eatingHours = fullFast ? 0 : Math.round(((end - start + 24) % 24) * 10) / 10;

    const updated = await ProtocolDay.findOneAndUpdate(
      { day },
      {
        day,
        phase: phase || 'Custom',
        protocolType: protocolType || 'eating_window',
        label: label || '',
        startHour: fullFast ? 9 : start,
        endHour: fullFast ? 9 : end,
        isFullDayFast: fullFast,
        eatingHours,
        fastingHours: Math.round((24 - eatingHours) * 10) / 10,
        focus: focus || '',
        waterTargetMl: waterTargetMl || 3000,
        updatedAt: new Date()
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ day: updated });
  } catch (err) {
    res.status(500).json({ error: 'Could not update protocol day', detail: err.message });
  }
});

// DELETE /api/admin/protocol/:day
router.delete('/protocol/:day', async (req, res) => {
  try {
    await ProtocolDay.deleteOne({ day: parseInt(req.params.day, 10) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete protocol day', detail: err.message });
  }
});

// POST /api/admin/clients/:id/apply-protocol { day, meals, milestones }
// Copies a protocol day onto a client as their regimen for that day.
router.post('/clients/:id/apply-protocol', async (req, res) => {
  try {
    const day = parseInt(req.body.day, 10);
    if (!day) return res.status(400).json({ error: 'day is required' });

    const template = await ProtocolDay.findOne({ day });
    if (!template) return res.status(404).json({ error: `Day ${day} is not in the protocol yet — seed it first` });

    const client = await User.findById(req.params.id);
    if (!client || client.role !== 'client') return res.status(404).json({ error: 'Client not found' });

    const milestones = [
      { key: 'water_target', label: `Hit ${template.waterTargetMl} ml of water` },
      { key: 'protocol_focus', label: template.focus || template.label || 'Follow today\'s protocol' }
    ];

    const regimen = await Regimen.findOneAndUpdate(
      { user: client._id, day },
      {
        user: client._id, day,
        fastingWindow: { startHour: template.startHour, endHour: template.endHour },
        isFullDayFast: template.isFullDayFast,
        protocolType: template.protocolType,
        phase: template.phase,
        focus: template.focus,
        meals: req.body.meals || [],
        milestones: req.body.milestones || milestones,
        waterTargetMl: template.waterTargetMl
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ regimen });
  } catch (err) {
    res.status(500).json({ error: 'Could not apply protocol', detail: err.message });
  }
});

// POST /api/admin/protocol/apply-all { day } — push one protocol day to every active client
router.post('/protocol/apply-all', async (req, res) => {
  try {
    const day = parseInt(req.body.day, 10);
    const template = await ProtocolDay.findOne({ day });
    if (!template) return res.status(404).json({ error: 'Protocol day not found' });

    const clients = await User.find({ role: 'client', status: 'active' }).select('_id');
    for (const c of clients) {
      await Regimen.findOneAndUpdate(
        { user: c._id, day },
        {
          user: c._id, day,
          fastingWindow: { startHour: template.startHour, endHour: template.endHour },
          isFullDayFast: template.isFullDayFast,
          protocolType: template.protocolType,
          phase: template.phase,
          focus: template.focus,
          waterTargetMl: template.waterTargetMl
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }
    res.json({ applied: clients.length });
  } catch (err) {
    res.status(500).json({ error: 'Could not apply protocol to cohort', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Payments / leaderboard / payouts                                    */
/* ------------------------------------------------------------------ */
router.get('/payments', async (req, res) => {
  const filter = req.query.status ? { status: req.query.status } : { status: 'pending' };
  const payments = await Payment.find(filter).populate('user', 'name email phone').sort({ createdAt: -1 });
  res.json({ payments });
});

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
  const plan = await Plan.findOne({ key: payment.tier });
  if (plan && plan.durationDays) client.challengeLengthDays = plan.durationDays;
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

router.get('/leaderboard', async (req, res) => {
  const clients = await User.find({ role: 'client', status: 'active' })
    .sort({ points: -1, streakCurrent: -1 })
    .select('name points streakCurrent streakBest tier');
  res.json({ leaderboard: clients });
});

router.get('/payouts', async (req, res) => {
  const filter = req.query.status ? { status: req.query.status } : { status: 'pending' };
  const payouts = await Payout.find(filter).populate('user', 'name email').sort({ requestedAt: -1 });
  res.json({ payouts });
});

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

router.post('/payouts/:id/reject', async (req, res) => {
  const payout = await Payout.findById(req.params.id);
  if (!payout) return res.status(404).json({ error: 'Payout not found' });
  payout.status = 'rejected';
  payout.resolvedAt = new Date();
  payout.resolvedBy = req.user._id;
  await payout.save();
  res.json({ payout });
});

/* ------------------------------------------------------------------ */
/* Plans — coach-customisable pricing / packages                       */
/* ------------------------------------------------------------------ */
router.get('/plans', async (req, res) => {
  let plans = await Plan.find({}).sort({ order: 1, priceInr: 1 });
  if (!plans.length) {
    await Plan.insertMany(Plan.DEFAULTS);
    plans = await Plan.find({}).sort({ order: 1, priceInr: 1 });
  }
  res.json({ plans });
});

router.post('/plans', async (req, res) => {
  try {
    const { key, name, priceInr, durationDays, tagline, features, active, order } = req.body;
    if (!name || priceInr === undefined) return res.status(400).json({ error: 'Name and price are required' });
    const planKey = (key || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!planKey) return res.status(400).json({ error: 'Give the plan a usable name' });
    if (await Plan.findOne({ key: planKey })) return res.status(409).json({ error: 'A plan with this name already exists' });

    const plan = await Plan.create({
      key: planKey, name, priceInr: Number(priceInr),
      durationDays: Number(durationDays) || 55,
      tagline: tagline || '',
      features: Array.isArray(features) ? features : String(features || '').split('\n').map(f => f.trim()).filter(Boolean),
      active: active !== false,
      order: Number(order) || 0
    });
    res.status(201).json({ plan });
  } catch (err) {
    res.status(500).json({ error: 'Could not create plan', detail: err.message });
  }
});

router.put('/plans/:id', async (req, res) => {
  try {
    const { name, priceInr, durationDays, tagline, features, active, order } = req.body;
    const plan = await Plan.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    if (name !== undefined) plan.name = name;
    if (priceInr !== undefined) plan.priceInr = Number(priceInr);
    if (durationDays !== undefined) plan.durationDays = Number(durationDays) || 55;
    if (tagline !== undefined) plan.tagline = tagline;
    if (features !== undefined) {
      plan.features = Array.isArray(features)
        ? features
        : String(features || '').split('\n').map(f => f.trim()).filter(Boolean);
    }
    if (active !== undefined) plan.active = !!active;
    if (order !== undefined) plan.order = Number(order) || 0;
    await plan.save();
    res.json({ plan });
  } catch (err) {
    res.status(500).json({ error: 'Could not update plan', detail: err.message });
  }
});

router.delete('/plans/:id', async (req, res) => {
  try {
    await Plan.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete plan', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Alerts — announcements to one client or the whole cohort            */
/* ------------------------------------------------------------------ */
router.get('/alerts', async (req, res) => {
  const alerts = await Alert.find({}).populate('user', 'name email').sort({ createdAt: -1 }).limit(100);
  res.json({ alerts });
});

router.post('/alerts', async (req, res) => {
  try {
    const { title, body, level, clientId } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and message are required' });
    const alert = await Alert.create({
      title: title.trim(), body: body.trim(),
      level: ['info', 'important', 'urgent'].includes(level) ? level : 'info',
      user: clientId && clientId !== 'all' ? clientId : null,
      createdBy: req.user._id
    });
    res.status(201).json({ alert });
  } catch (err) {
    res.status(500).json({ error: 'Could not send alert', detail: err.message });
  }
});

router.delete('/alerts/:id', async (req, res) => {
  await Alert.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Chat with clients                                                   */
/* ------------------------------------------------------------------ */
router.get('/messages/threads', async (req, res) => {
  const clients = await User.find({ role: 'client' }).select('name email status').sort({ name: 1 });
  const threads = await Promise.all(clients.map(async (c) => {
    const [last, unread] = await Promise.all([
      Message.findOne({ client: c._id }).sort({ createdAt: -1 }),
      Message.countDocuments({ client: c._id, sender: 'client', readByAdmin: false })
    ]);
    return {
      _id: c._id, name: c.name, email: c.email, status: c.status,
      lastMessage: last ? last.body : '',
      lastAt: last ? last.createdAt : null,
      lastSender: last ? last.sender : null,
      unread
    };
  }));
  threads.sort((a, b) => (b.unread - a.unread) || (new Date(b.lastAt || 0) - new Date(a.lastAt || 0)));
  res.json({ threads, totalUnread: threads.reduce((n, t) => n + t.unread, 0) });
});

router.get('/messages/:clientId', async (req, res) => {
  const messages = await Message.find({ client: req.params.clientId }).sort({ createdAt: 1 }).limit(300);
  await Message.updateMany({ client: req.params.clientId, sender: 'client', readByAdmin: false }, { readByAdmin: true });
  const client = await User.findById(req.params.clientId).select('name email phone status');
  res.json({ messages, client });
});

router.post('/messages/:clientId', async (req, res) => {
  try {
    const body = (req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Type a message first' });
    const message = await Message.create({
      client: req.params.clientId, sender: 'admin', body, readByAdmin: true, readByClient: false
    });
    res.status(201).json({ message });
  } catch (err) {
    res.status(500).json({ error: 'Could not send message', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Referral overview                                                   */
/* ------------------------------------------------------------------ */
router.get('/referrals', async (req, res) => {
  const clients = await User.find({ role: 'client' })
    .select('name email referralCode referredBy walletBalanceInr status createdAt')
    .sort({ walletBalanceInr: -1, createdAt: -1 });

  const byId = new Map(clients.map(c => [String(c._id), c]));
  const rows = await Promise.all(clients.map(async (c) => {
    const referred = clients.filter(x => String(x.referredBy) === String(c._id));
    const pendingPayouts = await Payout.countDocuments({ user: c._id, status: 'pending' });
    const paidOut = await Payout.aggregate([
      { $match: { user: c._id, status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amountInr' } } }
    ]);
    const referrer = c.referredBy ? byId.get(String(c.referredBy)) : null;
    return {
      _id: c._id, name: c.name, email: c.email, status: c.status,
      referralCode: c.referralCode || '—',
      walletBalanceInr: c.walletBalanceInr,
      referredCount: referred.length,
      referredNames: referred.map(r => r.name),
      referredByName: referrer ? referrer.name : '',
      pendingPayouts,
      paidOutInr: paidOut.length ? paidOut[0].total : 0
    };
  }));

  res.json({
    referrals: rows,
    totals: {
      clients: rows.length,
      referredClients: rows.filter(r => r.referredByName).length,
      walletOutstanding: rows.reduce((n, r) => n + (r.walletBalanceInr || 0), 0),
      paidOut: rows.reduce((n, r) => n + (r.paidOutInr || 0), 0)
    }
  });
});

// Manual wallet adjustment, in case a referral needs fixing by hand
router.post('/referrals/:id/adjust', async (req, res) => {
  try {
    const amount = Number(req.body.amountInr);
    if (!amount) return res.status(400).json({ error: 'Enter an amount (use a negative number to deduct)' });
    const client = await User.findById(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    client.walletBalanceInr = Math.max(0, (client.walletBalanceInr || 0) + amount);
    await client.save();
    res.json({ walletBalanceInr: client.walletBalanceInr });
  } catch (err) {
    res.status(500).json({ error: 'Could not adjust wallet', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Contact-us settings shown to clients                                */
/* ------------------------------------------------------------------ */
router.get('/settings', async (req, res) => {
  res.json({ settings: await Settings.getOrCreate() });
});

router.put('/settings', async (req, res) => {
  try {
    const s = await Settings.getOrCreate();
    ['coachName', 'phone', 'whatsapp', 'email', 'upiId', 'address', 'supportHours', 'note']
      .forEach(k => { if (req.body[k] !== undefined) s[k] = String(req.body[k]).trim(); });
    s.updatedAt = new Date();
    await s.save();
    res.json({ settings: s });
  } catch (err) {
    res.status(500).json({ error: 'Could not save settings', detail: err.message });
  }
});

module.exports = router;
