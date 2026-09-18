const express = require('express');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const {
  User, WeightLog, Plan, Payment, Payout,
  Regimen, RegimenMeal, RegimenMilestone,
  ChecklistLog, ChecklistItem, WaterEntry,
  Alert, AlertRead, Message, Settings, TrackerSession
} = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateReferralCode } = require('../utils/helpers');
const { PROTOCOL_DAYS, SAFETY_NOTES } = require('../utils/protocolDefaults');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

/* ------------------------------------------------------------------ */
/* Clients / roster                                                     */
/* ------------------------------------------------------------------ */
router.post('/clients', async (req, res) => {
  try {
    const { name, email, phone, password, tier, activateNow } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await User.findOne({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    let code;
    do { code = generateReferralCode(name); } while (await User.findOne({ where: { referralCode: code } }));

    const passwordHash = await bcrypt.hash(password, 10);
    let planMode = 'protocol', status = 'pending_payment', challengeStartDate = null;
    if (tier) {
      const plan = await Plan.findOne({ where: { key: tier } });
      if (plan) planMode = plan.mode;
    }
    if (activateNow) {
      status = 'active';
      challengeStartDate = new Date().toISOString().slice(0, 10);
    }

    const user = await User.create({
      name, email: email.toLowerCase(), phone, passwordHash, role: 'client',
      tier: tier || 'none', planMode, status, challengeStartDate, referralCode: code
    });
    res.status(201).json({ user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Could not create client', detail: err.message });
  }
});

// Clean roster feed: name, status, day, plan mode, live window (raw hours —
// the admin frontend renders live state in the CLIENT's own timezone, not
// the coach's browser time), adherence.
router.get('/clients', async (req, res) => {
  const clients = await User.findAll({ where: { role: 'client' }, order: [['createdAt', 'DESC']] });
  const results = await Promise.all(clients.map(async (c) => {
    const day = c.currentChallengeDay();
    let regimen = null, completionPercent = null;
    if (c.planMode === 'protocol' && day > 0) {
      regimen = await Regimen.findOne({ where: { userId: c.id, day } });
      const log = await ChecklistLog.findOne({ where: { userId: c.id, day } });
      completionPercent = log ? log.completionPercent : 0;
    }
    return {
      id: c.id, name: c.name, email: c.email, phone: c.phone,
      status: c.status, planMode: c.planMode, tier: c.tier,
      timezone: c.timezone, day, challengeLengthDays: c.challengeLengthDays,
      points: c.points, streakCurrent: c.streakCurrent,
      fastingPause: { active: c.pauseActive, reason: c.pauseReason },
      window: regimen ? { startHour: regimen.startHour, endHour: regimen.endHour, isFullDayFast: regimen.isFullDayFast } : null,
      completionPercent
    };
  }));
  res.json({ clients: results });
});

router.get('/clients/:id', async (req, res) => {
  const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const weightLogs = await WeightLog.findAll({ where: { userId: client.id }, order: [['date', 'ASC']] });
  const regimens = await Regimen.findAll({
    where: { userId: client.id }, order: [['day', 'ASC']],
    include: [{ model: RegimenMeal, as: 'meals' }, { model: RegimenMilestone, as: 'milestones' }]
  });
  const checklistLogs = await ChecklistLog.findAll({ where: { userId: client.id }, order: [['day', 'ASC']] });
  res.json({ client: client.toSafeJSON(), weightLogs, regimens, checklistLogs });
});

router.post('/clients/:id/activate', async (req, res) => {
  const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  client.status = 'active';
  if (!client.challengeStartDate) client.challengeStartDate = new Date().toISOString().slice(0, 10);
  await client.save();
  res.json({ client: client.toSafeJSON() });
});

router.post('/clients/:id/reset-password', async (req, res) => {
  const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  client.passwordHash = await bcrypt.hash(password, 10);
  await client.save();
  res.json({ ok: true });
});

router.post('/clients/:id/pause', async (req, res) => {
  const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { pause, reason } = req.body;
  if (pause) {
    client.pauseActive = true;
    client.pauseReason = reason || '';
    client.pauseStartedAt = new Date();
  } else {
    if (client.pauseActive && client.pauseStartedAt) {
      const start = new Date(client.pauseStartedAt);
      const now = new Date();
      const startLocal = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const nowLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      client.pausedDays = (client.pausedDays || 0) + Math.max(0, Math.round((nowLocal - startLocal) / 86400000));
    }
    client.pauseActive = false;
    client.pauseReason = '';
  }
  await client.save();
  res.json({ client: client.toSafeJSON() });
});

/* ------------------------------------------------------------------ */
/* Assign plan — replaces the old standalone "protocol" tab.           */
/* The coach picks a day (pre-filled from the static 55-day defaults    */
/* below, editable), adds meals/habits, and applies it to one client    */
/* or to every active protocol-mode client. This IS the source of       */
/* truth — there's no separate template that can drift out of sync.    */
/* ------------------------------------------------------------------ */

// GET /api/admin/protocol-defaults  — static reference for the day picker
router.get('/protocol-defaults', (req, res) => {
  res.json({ days: PROTOCOL_DAYS, safetyNotes: SAFETY_NOTES });
});

async function writeRegimen(userId, payload) {
  const { day, startHour, endHour, isFullDayFast, protocolType, phase, focus, waterTargetMl, meals, milestones } = payload;

  const [regimen] = await Regimen.findOrCreate({
    where: { userId, day },
    defaults: { userId, day, startHour: 9, endHour: 17 }
  });
  regimen.startHour = isFullDayFast ? (startHour ?? regimen.startHour) : startHour;
  regimen.endHour = isFullDayFast ? (endHour ?? regimen.endHour) : endHour;
  regimen.isFullDayFast = !!isFullDayFast;
  regimen.protocolType = protocolType || 'eating_window';
  regimen.phase = phase || '';
  regimen.focus = focus || '';
  regimen.waterTargetMl = waterTargetMl || 3000;
  await regimen.save();

  await RegimenMeal.destroy({ where: { regimenId: regimen.id } });
  await RegimenMilestone.destroy({ where: { regimenId: regimen.id } });
  if (Array.isArray(meals) && meals.length) {
    await RegimenMeal.bulkCreate(meals.map(m => ({ ...m, regimenId: regimen.id })));
  }
  if (Array.isArray(milestones) && milestones.length) {
    await RegimenMilestone.bulkCreate(milestones.map(m => ({ ...m, regimenId: regimen.id })));
  }
  return regimen;
}

// POST /api/admin/clients/:id/assign-plan
router.post('/clients/:id/assign-plan', async (req, res) => {
  try {
    const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.planMode !== 'protocol') return res.status(400).json({ error: 'This client is on the Fasting Tracker plan and has no coach-assigned regimen.' });
    if (!req.body.day) return res.status(400).json({ error: 'day is required' });

    const regimen = await writeRegimen(client.id, req.body);
    res.json({ regimen });
  } catch (err) {
    res.status(500).json({ error: 'Could not assign plan', detail: err.message });
  }
});

// POST /api/admin/assign-plan/apply-all  — push the same day to every active protocol client
router.post('/assign-plan/apply-all', async (req, res) => {
  try {
    if (!req.body.day) return res.status(400).json({ error: 'day is required' });
    const clients = await User.findAll({ where: { role: 'client', planMode: 'protocol', status: 'active' } });
    for (const c of clients) {
      await writeRegimen(c.id, req.body);
    }
    res.json({ applied: clients.length });
  } catch (err) {
    res.status(500).json({ error: 'Could not apply plan to cohort', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Payments                                                              */
/* ------------------------------------------------------------------ */
router.get('/payments', async (req, res) => {
  const status = req.query.status;
  const where = status ? { status } : {};
  const payments = await Payment.findAll({ where, include: [{ model: User, attributes: ['id', 'name', 'email'] }], order: [['createdAt', 'DESC']] });
  res.json({ payments });
});

router.post('/payments/:id/approve', async (req, res) => {
  try {
    const payment = await Payment.findByPk(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    const client = await User.findByPk(payment.userId);
    const plan = await Plan.findOne({ where: { key: payment.tier } });

    payment.status = 'approved';
    payment.reviewedBy = req.user.id;
    payment.reviewedAt = new Date();
    await payment.save();

    client.status = 'active';
    client.tier = payment.tier;
    client.planMode = plan ? plan.mode : 'protocol';
    client.challengeStartDate = new Date().toISOString().slice(0, 10);
    client.challengeLengthDays = plan ? plan.durationDays : 55;
    await client.save();

    // First-ever approved payment triggers the referral reward.
    if (client.referredBy) {
      const approvedCount = await Payment.count({ where: { userId: client.id, status: 'approved' } });
      if (approvedCount === 1) {
        const referrer = await User.findByPk(client.referredBy);
        if (referrer) {
          referrer.walletBalanceInr += 500;
          await referrer.save();
        }
      }
    }
    res.json({ payment, client: client.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Could not approve payment', detail: err.message });
  }
});

router.post('/payments/:id/reject', async (req, res) => {
  const payment = await Payment.findByPk(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  payment.status = 'rejected';
  payment.reviewedBy = req.user.id;
  payment.reviewedAt = new Date();
  payment.adminNote = req.body.note || '';
  await payment.save();
  res.json({ payment });
});

/* ------------------------------------------------------------------ */
/* Payouts                                                               */
/* ------------------------------------------------------------------ */
router.get('/payouts', async (req, res) => {
  const status = req.query.status;
  const where = status ? { status } : {};
  const payouts = await Payout.findAll({ where, include: [{ model: User, attributes: ['id', 'name', 'email'] }], order: [['requestedAt', 'DESC']] });
  res.json({ payouts });
});

router.post('/payouts/:id/approve', async (req, res) => {
  const payout = await Payout.findByPk(req.params.id);
  if (!payout) return res.status(404).json({ error: 'Payout not found' });
  const client = await User.findByPk(payout.userId);
  if (client.walletBalanceInr < payout.amountInr) return res.status(400).json({ error: 'Insufficient wallet balance' });
  client.walletBalanceInr -= payout.amountInr;
  await client.save();
  payout.status = 'paid';
  payout.resolvedAt = new Date();
  payout.resolvedBy = req.user.id;
  await payout.save();
  res.json({ payout });
});

router.post('/payouts/:id/reject', async (req, res) => {
  const payout = await Payout.findByPk(req.params.id);
  if (!payout) return res.status(404).json({ error: 'Payout not found' });
  payout.status = 'rejected';
  payout.resolvedAt = new Date();
  payout.resolvedBy = req.user.id;
  await payout.save();
  res.json({ payout });
});

/* ------------------------------------------------------------------ */
/* Plans & pricing (coach-editable — includes Fasting Tracker plans)    */
/* ------------------------------------------------------------------ */
router.get('/plans', async (req, res) => {
  let plans = await Plan.findAll({ order: [['order', 'ASC'], ['priceInr', 'ASC']] });
  if (!plans.length) {
    await Plan.bulkCreate(Plan.DEFAULTS);
    plans = await Plan.findAll({ order: [['order', 'ASC'], ['priceInr', 'ASC']] });
  }
  res.json({ plans });
});

router.post('/plans', async (req, res) => {
  try {
    const { key, name, priceInr, durationDays, tagline, features, mode, order } = req.body;
    if (!key || !name || !priceInr) return res.status(400).json({ error: 'key, name and priceInr are required' });
    const plan = await Plan.create({
      key: key.toLowerCase().trim(), name, priceInr, durationDays: durationDays || 55,
      tagline: tagline || '', features: features || [], mode: mode === 'tracker' ? 'tracker' : 'protocol', order: order || 0
    });
    res.status(201).json({ plan });
  } catch (err) {
    res.status(500).json({ error: 'Could not create plan', detail: err.message });
  }
});

router.put('/plans/:id', async (req, res) => {
  try {
    const plan = await Plan.findByPk(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const { name, priceInr, durationDays, tagline, features, mode, order, active } = req.body;
    if (name) plan.name = name;
    if (priceInr) plan.priceInr = priceInr;
    if (durationDays) plan.durationDays = durationDays;
    if (typeof tagline === 'string') plan.tagline = tagline;
    if (Array.isArray(features)) plan.features = features;
    if (mode) plan.mode = mode === 'tracker' ? 'tracker' : 'protocol';
    if (typeof order === 'number') plan.order = order;
    if (typeof active === 'boolean') plan.active = active;
    await plan.save();
    res.json({ plan });
  } catch (err) {
    res.status(500).json({ error: 'Could not update plan', detail: err.message });
  }
});

router.delete('/plans/:id', async (req, res) => {
  await Plan.destroy({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Leaderboard (admin view)                                             */
/* ------------------------------------------------------------------ */
router.get('/leaderboard', async (req, res) => {
  const clients = await User.findAll({
    where: { role: 'client', planMode: 'protocol' },
    order: [['points', 'DESC']],
    attributes: ['id', 'name', 'points', 'streakCurrent', 'streakBest', 'status']
  });
  res.json({ leaderboard: clients });
});

/* ------------------------------------------------------------------ */
/* Referral overview                                                     */
/* ------------------------------------------------------------------ */
router.get('/referrals', async (req, res) => {
  const clients = await User.findAll({ where: { role: 'client' }, attributes: ['id', 'name', 'email', 'referralCode', 'referredBy', 'walletBalanceInr'] });
  const byId = new Map(clients.map(c => [c.id, c]));
  const overview = clients.map(c => ({
    id: c.id, name: c.name, email: c.email, referralCode: c.referralCode,
    referredByName: c.referredBy && byId.has(c.referredBy) ? byId.get(c.referredBy).name : null,
    referredCount: clients.filter(x => x.referredBy === c.id).length,
    walletBalanceInr: c.walletBalanceInr
  }));
  res.json({ overview });
});

router.post('/referrals/:id/adjust-wallet', async (req, res) => {
  const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { deltaInr, note } = req.body;
  client.walletBalanceInr = Math.max(0, client.walletBalanceInr + (deltaInr || 0));
  await client.save();
  res.json({ client: client.toSafeJSON(), note: note || '' });
});

/* ------------------------------------------------------------------ */
/* Alerts                                                                */
/* ------------------------------------------------------------------ */
router.post('/alerts', async (req, res) => {
  try {
    const { userId, title, body, level } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
    const alert = await Alert.create({ userId: userId || null, title, body, level: level || 'info', createdBy: req.user.id });
    res.status(201).json({ alert });
  } catch (err) {
    res.status(500).json({ error: 'Could not send alert', detail: err.message });
  }
});

router.get('/alerts', async (req, res) => {
  const alerts = await Alert.findAll({ order: [['createdAt', 'DESC']], limit: 100 });
  res.json({ alerts });
});

/* ------------------------------------------------------------------ */
/* Chat (per-client threads)                                            */
/* ------------------------------------------------------------------ */
router.get('/messages/threads', async (req, res) => {
  const clients = await User.findAll({ where: { role: 'client' }, attributes: ['id', 'name'] });
  const threads = await Promise.all(clients.map(async (c) => {
    const unread = await Message.count({ where: { clientId: c.id, sender: 'client', readByAdmin: false } });
    const last = await Message.findOne({ where: { clientId: c.id }, order: [['createdAt', 'DESC']] });
    return { clientId: c.id, name: c.name, unread, lastMessage: last };
  }));
  res.json({ threads: threads.filter(t => t.lastMessage).sort((a, b) => b.lastMessage.createdAt - a.lastMessage.createdAt) });
});

router.get('/messages/:clientId', async (req, res) => {
  const messages = await Message.findAll({ where: { clientId: req.params.clientId }, order: [['createdAt', 'ASC']] });
  await Message.update({ readByAdmin: true }, { where: { clientId: req.params.clientId, sender: 'client' } });
  res.json({ messages });
});

router.post('/messages/:clientId', async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });
  const message = await Message.create({ clientId: req.params.clientId, sender: 'admin', body: body.trim() });
  res.status(201).json({ message });
});

/* ------------------------------------------------------------------ */
/* Contact / settings                                                    */
/* ------------------------------------------------------------------ */
router.get('/settings', async (req, res) => {
  const settings = await Settings.getOrCreate();
  res.json({ settings });
});

router.put('/settings', async (req, res) => {
  const settings = await Settings.getOrCreate();
  const fields = ['coachName', 'phone', 'whatsapp', 'email', 'upiId', 'address', 'supportHours', 'note'];
  for (const f of fields) if (typeof req.body[f] === 'string') settings[f] = req.body[f];
  await settings.save();
  res.json({ settings });
});

module.exports = router;
