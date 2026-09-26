const express = require('express');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const {
  User, WeightLog, Plan, Payment, Payout,
  Regimen, RegimenMeal, RegimenMilestone,
  ChecklistLog, ChecklistItem, WaterEntry,
  Alert, AlertRead, Message, Settings, TrackerSession, TrackerWaterEntry
} = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateReferralCode } = require('../utils/helpers');
const { PROTOCOL_DAYS, SAFETY_NOTES } = require('../utils/protocolDefaults');
const { MEAL_PRESETS } = require('../utils/mealPresets');

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
  const latest = weightLogs.length ? weightLogs[weightLogs.length - 1].weightKg : null;
  const first = weightLogs.length ? weightLogs[0].weightKg : null;
  res.json({
    client: client.toSafeJSON(), weightLogs, regimens, checklistLogs,
    // Body metrics the client saved from their BMI calculator. Read-only
    // here — the coach sees it, the client owns it.
    body: {
      heightCm: client.heightCm, age: client.age, gender: client.gender,
      currentWeightKg: latest, startWeightKg: first,
      changeKg: latest !== null && first !== null ? Math.round((latest - first) * 10) / 10 : null,
      bmi: client.bmi(latest), healthyWeightRange: client.healthyWeightRange()
    }
  });
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

// GET /api/admin/meal-presets — quick-add library for the Assign Plan meal rows.
// Purely a convenience list; the coach can still fully edit or delete any row.
router.get('/meal-presets', (req, res) => {
  res.json({ presets: MEAL_PRESETS });
});

// GET /api/admin/clients/:id/regimen/:day
// What the client ACTUALLY has assigned for that day, so re-opening
// "Assign plan" shows the last saved plan instead of a blank form.
router.get('/clients/:id/regimen/:day', async (req, res) => {
  try {
    const regimen = await Regimen.findOne({
      where: { userId: req.params.id, day: req.params.day },
      include: [{ model: RegimenMeal, as: 'meals' }, { model: RegimenMilestone, as: 'milestones' }]
    });
    if (!regimen) return res.json({ regimen: null, assigned: false });
    res.json({
      assigned: true,
      regimen: {
        day: regimen.day, startHour: regimen.startHour, endHour: regimen.endHour,
        isFullDayFast: regimen.isFullDayFast, protocolType: regimen.protocolType,
        phase: regimen.phase, focus: regimen.focus, dayInfo: regimen.dayInfo,
        waterTargetMl: regimen.waterTargetMl,
        updatedAt: regimen.updatedAt,
        meals: regimen.meals.map(m => ({ type: m.type, name: m.name, calories: m.calories })),
        milestones: regimen.milestones.map(m => ({ itemKey: m.itemKey, label: m.label }))
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load the assigned plan', detail: err.message });
  }
});

// GET /api/admin/clients/:id/assigned-days — day numbers already assigned,
// so the coach can see at a glance what is filled in and what is not.
router.get('/clients/:id/assigned-days', async (req, res) => {
  const rows = await Regimen.findAll({
    where: { userId: req.params.id }, order: [['day', 'ASC']],
    attributes: ['day', 'isFullDayFast', 'focus', 'dayInfo', 'updatedAt']
  });
  const client = await User.findByPk(req.params.id);
  res.json({
    days: rows,
    currentDay: client ? client.currentChallengeDay() : 0,
    challengeLengthDays: client ? client.challengeLengthDays : 55
  });
});

// PATCH /api/admin/clients/:id — coach-editable client facts, including
// the challenge length (needed when assigning a day past the 55th).
router.patch('/clients/:id', async (req, res) => {
  try {
    const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    for (const f of ['challengeLengthDays', 'heightCm', 'age', 'gender', 'timezone']) {
      if (req.body[f] !== undefined && req.body[f] !== null && req.body[f] !== '') client[f] = req.body[f];
    }
    if (req.body.challengeStartDate) client.challengeStartDate = req.body.challengeStartDate;
    await client.save();
    res.json({ client: client.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Could not update client', detail: err.message });
  }
});

async function writeRegimen(userId, payload) {
  const { day, startHour, endHour, isFullDayFast, protocolType, phase, focus, dayInfo, waterTargetMl, meals, milestones } = payload;

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
  regimen.dayInfo = dayInfo || '';
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
// Optional `repeatDays` (>=1): writes the SAME window/meals/habits/day-info
// to `repeatDays` consecutive days starting at `day` — e.g. day=10,
// repeatDays=6 assigns days 10,11,12,13,14,15 identically, in one action,
// instead of the coach repeating the whole form six times.
router.post('/clients/:id/assign-plan', async (req, res) => {
  try {
    const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.planMode !== 'protocol') return res.status(400).json({ error: 'This client is on the Fasting Tracker plan and has no coach-assigned regimen.' });
    const startDay = parseInt(req.body.day, 10);
    if (!startDay || startDay < 1) return res.status(400).json({ error: 'day must be 1 or higher' });
    const repeatDays = Math.max(1, Math.min(90, parseInt(req.body.repeatDays, 10) || 1));
    const endDay = startDay + repeatDays - 1;

    // Custom days: assigning past the end of the challenge simply extends
    // it, so the coach is never boxed in by the original 55.
    if (endDay > client.challengeLengthDays) {
      client.challengeLengthDays = endDay;
      await client.save();
    }

    const regimens = [];
    for (let day = startDay; day <= endDay; day++) {
      regimens.push(await writeRegimen(client.id, { ...req.body, day }));
    }
    res.json({
      regimen: regimens[0], regimens,
      daysAssigned: { from: startDay, to: endDay, count: regimens.length },
      challengeLengthDays: client.challengeLengthDays
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not assign plan', detail: err.message });
  }
});

// POST /api/admin/assign-plan/apply-all — push the same day range to every
// active protocol client. Same `repeatDays` support as the single-client route.
router.post('/assign-plan/apply-all', async (req, res) => {
  try {
    const startDay = parseInt(req.body.day, 10);
    if (!startDay || startDay < 1) return res.status(400).json({ error: 'day must be 1 or higher' });
    const repeatDays = Math.max(1, Math.min(90, parseInt(req.body.repeatDays, 10) || 1));
    const endDay = startDay + repeatDays - 1;
    const clients = await User.findAll({ where: { role: 'client', planMode: 'protocol', status: 'active' } });
    for (const c of clients) {
      if (endDay > c.challengeLengthDays) { c.challengeLengthDays = endDay; await c.save(); }
      for (let day = startDay; day <= endDay; day++) {
        await writeRegimen(c.id, { ...req.body, day });
      }
    }
    res.json({ applied: clients.length, daysAssigned: { from: startDay, to: endDay, count: repeatDays } });
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
