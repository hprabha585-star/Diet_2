const express = require('express');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const {
  User, WeightLog, Plan, Payment, Payout,
  Regimen, RegimenMeal, RegimenMilestone,
  ChecklistLog, ChecklistItem, WaterEntry,
  Alert, AlertRead, Message, Settings, ProtocolDay, TrackerSession, TrackerWaterEntry, JournalTopic
} = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateReferralCode } = require('../utils/helpers');
// Fallbacks only — the coach's live, editable protocol lives in the
// ProtocolDay table and Settings.protocolPhaseGoals/protocolSafetyNotes
// (see models/index.js); this file's static data is just the original
// seed for a fresh database.
const { SAFETY_NOTES, PHASE_GOALS } = require('../utils/protocolDefaults');
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
      tier: tier || 'none', planMode, status, challengeStartDate, referralCode: code,
      hasProtocolAccess: activateNow && planMode === 'protocol',
      hasTrackerAccess: activateNow && planMode === 'tracker'
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
    const hasProtocolAccess = c.hasProtocolMode();
    const hasTrackerAccess = c.hasTrackerMode();
    let regimen = null, completionPercent = null;
    if (hasProtocolAccess && day > 0) {
      regimen = await Regimen.findOne({ where: { userId: c.id, day } });
      const log = await ChecklistLog.findOne({ where: { userId: c.id, day } });
      completionPercent = log ? log.completionPercent : 0;
    }
    return {
      id: c.id, name: c.name, email: c.email, phone: c.phone,
      status: c.status, planMode: c.planMode, tier: c.tier,
      hasProtocolAccess, hasTrackerAccess, isDualAccess: hasProtocolAccess && hasTrackerAccess,
      timezone: c.timezone, day, challengeLengthDays: c.challengeLengthDays,
      // Plan duration/validity, so the coach can see at a glance how long
      // this client's plan runs and how much of it is left, without
      // opening their detail card.
      daysLeft: c.daysLeft(), dueDate: c.dueDate(), expired: c.isExpired(),
      points: c.points, streakCurrent: c.streakCurrent,
      fastingPause: { active: c.pauseActive, reason: c.pauseReason, pausedBy: c.pausedBy },
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
    },
    validity: { daysLeft: client.daysLeft(), dueDate: client.dueDate(), expired: client.isExpired() },
    // Medical & personal details — filled in by the client themselves,
    // read-only here so the coach can factor it into meal assignment.
    medical: {
      medicalConditions: client.medicalConditions || '',
      allergies: client.allergies || '',
      medications: client.medications || '',
      medicalNotes: client.medicalNotes || ''
    }
  });
});

// DELETE /api/admin/clients/:id — permanently removes a client and every
// row that belongs to them (weight logs, regimens, payments, etc. all
// cascade via each model's onDelete: 'CASCADE' association).
router.delete('/clients/:id', async (req, res) => {
  const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  await client.destroy();
  res.json({ ok: true });
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
    // Marks this as a COACH-initiated pause — the client can see it but
    // can't resume it themselves (see routes/client.js fasting/resume).
    client.pausedBy = 'admin';
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
    client.pausedBy = null;
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

// GET /api/admin/protocol-defaults — the coach's LIVE 55-day protocol
// (editable, backed by the ProtocolDay table — see models/index.js).
// Feeds the day picker, "Fill from 55-day protocol", and the standalone
// 55-day protocol page alike, so an edit here shows up everywhere at once.
router.get('/protocol-defaults', async (req, res) => {
  try {
    const days = await ProtocolDay.getAllOrSeed();
    // settings.protocolPhaseGoals/protocolSafetyNotes are read separately
    // and defensively: on a server whose `npm run migrate` hasn't been
    // re-run since these columns were added, SELECT-ing them throws
    // "Unknown column" and used to take this whole page down with a 500.
    // Falling back to the static defaults keeps the page usable either
    // way — it just means edits made on the 55-day protocol page won't
    // persist until the migration actually runs.
    let phaseGoals = PHASE_GOALS, safetyNotes = SAFETY_NOTES;
    try {
      const settings = await Settings.getOrCreate();
      phaseGoals = settings.protocolPhaseGoals || PHASE_GOALS;
      safetyNotes = settings.protocolSafetyNotes || SAFETY_NOTES;
    } catch (settingsErr) {
      console.error('Settings.protocolPhaseGoals/protocolSafetyNotes unavailable (run `npm run migrate`):', settingsErr.message);
    }
    res.json({ days, phaseGoals, safetyNotes });
  } catch (err) {
    res.status(500).json({ error: 'Could not load the 55-day protocol', detail: err.message });
  }
});

// PATCH /api/admin/protocol-defaults/:day — edit one day of the baseline
// protocol. Only touches this reference table, never a client's own
// assigned Regimen — a client already on this day keeps whatever was
// assigned to them until the coach re-assigns or re-seeds their guide.
router.patch('/protocol-defaults/:day', async (req, res) => {
  try {
    const day = parseInt(req.params.day, 10);
    const row = await ProtocolDay.findOne({ where: { day } });
    if (!row) return res.status(404).json({ error: `Day ${day} not found in the protocol` });

    for (const f of ['phase', 'protocolType', 'label', 'focus']) {
      if (typeof req.body[f] === 'string') row[f] = req.body[f];
    }
    if (typeof req.body.isFullDayFast === 'boolean') row.isFullDayFast = req.body.isFullDayFast;
    if (req.body.waterTargetMl !== undefined) row.waterTargetMl = parseInt(req.body.waterTargetMl, 10) || row.waterTargetMl;
    if (row.isFullDayFast) {
      row.startHour = 9; row.endHour = 9;
      row.eatingHours = 0; row.fastingHours = 24;
    } else {
      if (req.body.startHour !== undefined) row.startHour = parseFloat(req.body.startHour);
      if (req.body.endHour !== undefined) row.endHour = parseFloat(req.body.endHour);
      const eating = Math.round((row.endHour - row.startHour) * 10) / 10;
      row.eatingHours = eating;
      row.fastingHours = Math.round((24 - eating) * 10) / 10;
    }
    await row.save();
    res.json({ day: row });
  } catch (err) {
    res.status(500).json({ error: 'Could not save that day', detail: err.message });
  }
});

// PUT /api/admin/protocol-defaults/phase-info — edit the six phase goal
// sentences and/or the safety guideline list shown on the 55-day
// protocol page (and used as the "phase goal" appended when seeding
// Program guide). Stored on Settings; null falls back to the coach's
// original document text.
router.put('/protocol-defaults/phase-info', async (req, res) => {
  try {
    const settings = await Settings.getOrCreate();
    if (req.body.phaseGoals && typeof req.body.phaseGoals === 'object') settings.protocolPhaseGoals = req.body.phaseGoals;
    if (Array.isArray(req.body.safetyNotes)) settings.protocolSafetyNotes = req.body.safetyNotes;
    await settings.save();
    res.json({ phaseGoals: settings.protocolPhaseGoals, safetyNotes: settings.protocolSafetyNotes });
  } catch (err) {
    const hint = /unknown column/i.test(err.message) ? ' — run `npm run migrate` on the server, then retry.' : '';
    res.status(500).json({ error: 'Could not save phase info', detail: err.message + hint });
  }
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
        phase: regimen.phase, focus: regimen.focus, waterTargetMl: regimen.waterTargetMl,
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
    attributes: ['day', 'isFullDayFast', 'focus', 'updatedAt']
  });
  const client = await User.findByPk(req.params.id);
  res.json({
    days: rows,
    currentDay: client ? client.currentChallengeDay() : 0,
    challengeLengthDays: client ? client.challengeLengthDays : 55
  });
});

// GET /api/admin/default-day-template — the coach's saved "default day":
// a reusable window + meal/habit set, so a normal day doesn't have to be
// retyped from scratch every single time.
router.get('/default-day-template', async (req, res) => {
  const settings = await Settings.getOrCreate();
  res.json({ template: settings.defaultDayTemplate || null });
});

// PUT /api/admin/default-day-template — save the current Assign Plan form
// (window + meals + habits, NOT the day number) as the standing default.
router.put('/default-day-template', async (req, res) => {
  try {
    const settings = await Settings.getOrCreate();
    const { startHour, endHour, isFullDayFast, focus, waterTargetMl, meals, milestones } = req.body;
    settings.defaultDayTemplate = {
      startHour, endHour, isFullDayFast: !!isFullDayFast, focus: focus || '',
      waterTargetMl: waterTargetMl || 3000,
      meals: Array.isArray(meals) ? meals : [],
      milestones: Array.isArray(milestones) ? milestones : [],
      savedAt: new Date().toISOString()
    };
    await settings.save();
    res.json({ template: settings.defaultDayTemplate });
  } catch (err) {
    res.status(500).json({ error: 'Could not save default day', detail: err.message });
  }
});

// GET /api/admin/clients/:id/program-guide — every day from 1 to the
// client's challenge length, with whatever focus text/phase is on record
// (or null for a day nothing has been written for yet). This is the
// day-by-day guide the coach edits and the client reads — separate from
// full meal assignment, for quick day-info touch-ups.
router.get('/clients/:id/program-guide', async (req, res) => {
  const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const regimens = await Regimen.findAll({
    where: { userId: client.id }, order: [['day', 'ASC']],
    attributes: ['day', 'phase', 'focus', 'protocolType', 'updatedAt', 'startHour', 'endHour', 'isFullDayFast']
  });
  const byDay = new Map(regimens.map(r => [r.day, r]));
  const days = [];
  for (let d = 1; d <= client.challengeLengthDays; d++) {
    const r = byDay.get(d);
    days.push({
      day: d, phase: r ? r.phase : '', focus: r ? r.focus : '', assigned: !!r,
      startHour: r ? r.startHour : 9, endHour: r ? r.endHour : 17,
      isFullDayFast: r ? r.isFullDayFast : false
    });
  }
  res.json({ days, currentDay: client.currentChallengeDay() });
});

// PATCH /api/admin/clients/:id/regimen/:day/focus — quick edit of the
// day-info text AND (now) the Eating/Fasting window, without touching
// that day's meals/habits. Creates the day (with sane window defaults)
// if it doesn't exist yet, so the coach can write the story of the
// programme — and set its window — ahead of assigning meals. This is
// the Program Guide editor's save call; Assign Plan's own fuller form
// still covers meals/habits.
router.patch('/clients/:id/regimen/:day/focus', async (req, res) => {
  try {
    const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const day = parseInt(req.params.day, 10);
    if (!day || day < 1) return res.status(400).json({ error: 'day must be 1 or higher' });
    if (day > client.challengeLengthDays) { client.challengeLengthDays = day; await client.save(); }

    const [regimen] = await Regimen.findOrCreate({
      where: { userId: client.id, day },
      defaults: { userId: client.id, day, startHour: 9, endHour: 17 }
    });
    regimen.focus = typeof req.body.focus === 'string' ? req.body.focus : regimen.focus;
    if (typeof req.body.phase === 'string') regimen.phase = req.body.phase;
    if (typeof req.body.isFullDayFast === 'boolean') regimen.isFullDayFast = req.body.isFullDayFast;
    if (typeof req.body.startHour === 'number') regimen.startHour = req.body.startHour;
    if (typeof req.body.endHour === 'number') regimen.endHour = req.body.endHour;
    await regimen.save();
    res.json({
      day: regimen.day, focus: regimen.focus, phase: regimen.phase,
      startHour: regimen.startHour, endHour: regimen.endHour, isFullDayFast: regimen.isFullDayFast
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not save day info', detail: err.message });
  }
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

// Local calendar date, never toISOString() — east of UTC, toISOString()
// on a local midnight rolls back a day, which would move a client's day
// count by one for anyone in, say, IST.
function isoDate(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// POST /api/admin/clients/:id/set-day — move a client's CURRENT day
// directly (e.g. day 7 -> day 10), independent of assigning any day's
// plan. Works backwards from challengeStartDate so currentChallengeDay()
// returns exactly the requested day as of "today" (the coach's own local
// date, sent from the browser so this isn't at the mercy of server
// timezone). Existing paused-days credit is preserved.
router.post('/clients/:id/set-day', async (req, res) => {
  try {
    const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.planMode !== 'protocol') return res.status(400).json({ error: 'This client is on the Fasting Tracker plan, which has no day count.' });

    const day = parseInt(req.body.day, 10);
    if (!day || day < 1) return res.status(400).json({ error: 'day must be 1 or higher' });
    if (day > client.challengeLengthDays) client.challengeLengthDays = day;

    const today = new Date((req.body.today || isoDate(new Date())) + 'T00:00:00');
    const offsetDays = (day - 1) + (client.pausedDays || 0);
    today.setDate(today.getDate() - offsetDays);
    client.challengeStartDate = isoDate(today);
    await client.save();

    res.json({ client: client.toSafeJSON(), day: client.currentChallengeDay() });
  } catch (err) {
    res.status(500).json({ error: 'Could not change the client\'s day', detail: err.message });
  }
});

// POST /api/admin/clients/:id/program-guide/seed-defaults — fills the
// Program Guide's day-info text from the coach's LIVE 55-day protocol
// (the ProtocolDay table — whatever the coach has it set to right now,
// including any edits made on the 55-day protocol page), so a fresh
// guide isn't a wall of "Not written yet." By default only touches days
// that have no text of their own yet; overwrite:true replaces
// everything. Never touches a day's window/meals/habits — focus (and
// phase label) only. A day that doesn't exist yet is created with the
// protocol's own window as a starting point; an existing day's
// window/meals are left exactly as the coach set them.
router.post('/clients/:id/program-guide/seed-defaults', async (req, res) => {
  try {
    const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.planMode !== 'protocol') return res.status(400).json({ error: 'This client is on the Fasting Tracker plan and has no Program Guide.' });

    const protocolDays = await ProtocolDay.getAllOrSeed();
    const settings = await Settings.getOrCreate();
    const phaseGoals = settings.protocolPhaseGoals || PHASE_GOALS;
    const textFor = (d) => {
      const goal = phaseGoals[d.phase];
      return goal ? `${d.focus}\n\n${d.phase} goal: ${goal}` : d.focus;
    };

    const overwrite = !!req.body.overwrite;
    const maxDay = Math.max(client.challengeLengthDays, protocolDays[protocolDays.length - 1].day);
    if (maxDay > client.challengeLengthDays) { client.challengeLengthDays = maxDay; await client.save(); }

    let seeded = 0, skipped = 0;
    for (const d of protocolDays) {
      const [regimen, created] = await Regimen.findOrCreate({
        where: { userId: client.id, day: d.day },
        defaults: {
          userId: client.id, day: d.day, phase: d.phase,
          startHour: d.startHour, endHour: d.endHour, isFullDayFast: d.isFullDayFast,
          protocolType: d.protocolType, waterTargetMl: d.waterTargetMl,
          focus: textFor(d)
        }
      });
      if (!created) {
        if (!overwrite && regimen.focus && regimen.focus.trim()) { skipped++; continue; }
        regimen.focus = textFor(d);
        if (!regimen.phase) regimen.phase = d.phase;
        await regimen.save();
      }
      seeded++;
    }
    res.json({ seeded, skipped, total: protocolDays.length });
  } catch (err) {
    res.status(500).json({ error: 'Could not seed the program guide', detail: err.message });
  }
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
// Body.days (optional, default 1): when >1, the SAME window/meals/habits
// are written to every day from `day` through `day + days - 1`. This is
// what makes "assign 6 days starting from day 6" a single action instead
// of six trips through the modal.
router.post('/clients/:id/assign-plan', async (req, res) => {
  try {
    const client = await User.findOne({ where: { id: req.params.id, role: 'client' } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.planMode !== 'protocol') return res.status(400).json({ error: 'This client is on the Fasting Tracker plan and has no coach-assigned regimen.' });
    const startDay = parseInt(req.body.day, 10);
    if (!startDay || startDay < 1) return res.status(400).json({ error: 'day must be 1 or higher' });
    const span = Math.max(1, Math.min(90, parseInt(req.body.days, 10) || 1));
    const endDay = startDay + span - 1;

    // Custom/range days: assigning past the end of the challenge simply
    // extends it, so the coach is never boxed in by the original 55.
    if (endDay > client.challengeLengthDays) {
      client.challengeLengthDays = endDay;
      await client.save();
    }

    let regimen = null;
    const days = [];
    for (let day = startDay; day <= endDay; day++) {
      regimen = await writeRegimen(client.id, { ...req.body, day });
      days.push(day);
    }
    res.json({ regimen, days, challengeLengthDays: client.challengeLengthDays });
  } catch (err) {
    res.status(500).json({ error: 'Could not assign plan', detail: err.message });
  }
});

// POST /api/admin/assign-plan/apply-all — push the same day (or day range)
// to every active protocol client at once.
router.post('/assign-plan/apply-all', async (req, res) => {
  try {
    const startDay = parseInt(req.body.day, 10);
    if (!startDay || startDay < 1) return res.status(400).json({ error: 'day must be 1 or higher' });
    const span = Math.max(1, Math.min(90, parseInt(req.body.days, 10) || 1));
    const endDay = startDay + span - 1;
    const clients = await User.findAll({ where: { role: 'client', planMode: 'protocol', status: 'active' } });
    for (const c of clients) {
      if (endDay > c.challengeLengthDays) { c.challengeLengthDays = endDay; await c.save(); }
      for (let day = startDay; day <= endDay; day++) {
        await writeRegimen(c.id, { ...req.body, day });
      }
    }
    res.json({ applied: clients.length, days: endDay - startDay + 1 });
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

    const approvedMode = plan ? plan.mode : 'protocol';
    client.status = 'active';
    client.tier = payment.tier;
    client.planMode = approvedMode; // newest approval becomes the primary/default view
    // Only touch the protocol day-counter fields when THIS approval is a
    // protocol plan — a client who already has an active 55-day plan and
    // now also buys the Fasting Tracker should keep their existing day
    // count, not have it reset by the tracker purchase.
    if (approvedMode === 'tracker') {
      client.hasTrackerAccess = true;
    } else {
      client.hasProtocolAccess = true;
      client.challengeStartDate = new Date().toISOString().slice(0, 10);
      client.challengeLengthDays = plan ? plan.durationDays : 55;
    }
    // Once a client has ANY approved payment — trial or paid — free/trial
    // plans stay hidden from them from now on (see GET /client/plans):
    // only a brand-new signup who has never enrolled in anything sees
    // the free/trial options. This flag is never cleared.
    client.hadPaidPlan = true;
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
    const { key, name, priceInr, durationDays, tagline, features, brochure, brochurePdfBase64, brochurePdfName, mode, order, isTrial } = req.body;
    if (!key || !name || !priceInr) return res.status(400).json({ error: 'key, name and priceInr are required' });
    const plan = await Plan.create({
      key: key.toLowerCase().trim(), name, priceInr, durationDays: durationDays || 55,
      tagline: tagline || '', features: features || [], brochure: brochure || '',
      brochurePdfBase64: brochurePdfBase64 || null, brochurePdfName: brochurePdfName || null,
      mode: mode === 'tracker' ? 'tracker' : 'protocol', order: order || 0, isTrial: !!isTrial
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
    const { name, priceInr, durationDays, tagline, features, brochure, brochurePdfBase64, brochurePdfName, mode, order, active, isTrial } = req.body;
    if (name) plan.name = name;
    if (priceInr) plan.priceInr = priceInr;
    if (durationDays) plan.durationDays = durationDays;
    if (typeof tagline === 'string') plan.tagline = tagline;
    if (Array.isArray(features)) plan.features = features;
    if (typeof brochure === 'string') plan.brochure = brochure;
    if (typeof isTrial === 'boolean') plan.isTrial = isTrial;
    // brochurePdfBase64 is explicitly sent as null by the admin UI's
    // "Remove PDF" button, so `undefined` (field simply absent from this
    // request) must leave it untouched while `null` clears it.
    if (brochurePdfBase64 !== undefined) {
      plan.brochurePdfBase64 = brochurePdfBase64;
      plan.brochurePdfName = brochurePdfBase64 ? (brochurePdfName || plan.brochurePdfName) : null;
    }
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
/* SVR Journal / Personal Notes — coach-written topics (title +        */
/* description + an optional YouTube link) shown to every active        */
/* client on their Program Guide page.                                  */
/* ------------------------------------------------------------------ */
router.get('/journal', async (req, res) => {
  const topics = await JournalTopic.findAll({ order: [['order', 'ASC'], ['id', 'ASC']] });
  res.json({ topics });
});

router.post('/journal', async (req, res) => {
  try {
    const { title, description, youtubeUrl, order } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const topic = await JournalTopic.create({ title, description: description || '', youtubeUrl: youtubeUrl || '', order: order || 0 });
    res.status(201).json({ topic });
  } catch (err) {
    res.status(500).json({ error: 'Could not create journal topic', detail: err.message });
  }
});

router.put('/journal/:id', async (req, res) => {
  try {
    const topic = await JournalTopic.findByPk(req.params.id);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });
    const { title, description, youtubeUrl, order, active } = req.body;
    if (title) topic.title = title;
    if (typeof description === 'string') topic.description = description;
    if (typeof youtubeUrl === 'string') topic.youtubeUrl = youtubeUrl;
    if (typeof order === 'number') topic.order = order;
    if (typeof active === 'boolean') topic.active = active;
    await topic.save();
    res.json({ topic });
  } catch (err) {
    res.status(500).json({ error: 'Could not update journal topic', detail: err.message });
  }
});

router.delete('/journal/:id', async (req, res) => {
  await JournalTopic.destroy({ where: { id: req.params.id } });
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

// PUT /api/admin/branding — website name + logo. Kept as its own route
// (rather than folded into /settings above) since a logo image can be a
// sizeable base64 payload and this is edited far less often than contact
// details. "" for siteName falls back to "FastCoach"; sending
// logoBase64: null removes the logo (back to text-only branding).
router.put('/branding', async (req, res) => {
  try {
    const settings = await Settings.getOrCreate();
    if (typeof req.body.siteName === 'string') settings.siteName = req.body.siteName.trim() || 'FastCoach';
    if (req.body.logoBase64 === null || typeof req.body.logoBase64 === 'string') settings.logoBase64 = req.body.logoBase64 || null;
    await settings.save();
    res.json({ siteName: settings.siteName, logoBase64: settings.logoBase64 });
  } catch (err) {
    res.status(500).json({ error: 'Could not save branding', detail: err.message });
  }
});

module.exports = router;
