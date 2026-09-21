/* ============================================================
   Fasting Tracker API  —  mounted at /api/tracker
   Only clients on a tracker-mode plan may use it.

   Timezone rule (same as the rest of the app): the server never decides
   what "today" is. Durations come from timestamps, which are absolute;
   anything keyed to a calendar day takes a `date` (YYYY-MM-DD) from the
   browser's own clock.
   ============================================================ */
const express = require('express');
const { Op } = require('sequelize');
const {
  User, TrackerSession, TrackerWaterEntry, TrackerProfile,
  MealEntry, RestDay, TrackerTaskLog, WeightLog
} = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  SCHEDULES, STAGES, EDUCATION, TIPS, DAILY_TASKS, GOAL_OPTIONS, SAFETY,
  stageFor, tipForDate
} = require('../utils/fastingContent');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

function requireTracker(req, res, next) {
  if (req.user.status !== 'active' && req.user.status !== 'paused') {
    return res.status(403).json({ error: 'Your account is not active yet. Complete payment and wait for coach approval.' });
  }
  if (req.user.planMode !== 'tracker') {
    return res.status(403).json({ error: 'The Fasting Tracker is a separate plan. Pick it up from the Payment page to unlock it.' });
  }
  next();
}
router.use(requireTracker);

const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const round1 = (n) => Math.round(n * 10) / 10;
// LOCAL calendar date, never toISOString(). For anywhere east of UTC,
// toISOString() on a local midnight rolls back to the previous day — which
// would file a whole day's fasting under yesterday for an IST client.
const isoDate = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
// Falls back to server time only if the browser sent nothing.
const localDateOf = (req) => (req.query && req.query.date) || (req.body && req.body.date) || isoDate(new Date());

/* ------------------------------------------------------------------ */
/* Static content + schedules                                          */
/* ------------------------------------------------------------------ */
router.get('/content', (req, res) => {
  const date = localDateOf(req);
  res.json({
    schedules: SCHEDULES, stages: STAGES, education: EDUCATION,
    tips: TIPS, tipOfDay: tipForDate(date), dailyTasks: DAILY_TASKS,
    goalOptions: GOAL_OPTIONS, safety: SAFETY
  });
});

// Every schedule with its clock times worked out from a start hour, so
// the picker can show "fast ends 12:00 PM, eating window ends 8:00 PM"
// before anything is started.
router.get('/schedules', async (req, res) => {
  const profile = await TrackerProfile.getOrCreateFor(req.user.id);
  const startHour = req.query.startHour !== undefined ? parseFloat(req.query.startHour) : profile.startHour;
  const fmt = (h) => {
    const t = ((h % 24) + 24) % 24;
    const hh = Math.floor(t), mm = Math.round((t - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  res.json({
    startHour,
    schedules: SCHEDULES.map(s => ({
      ...s,
      suggestedStart: fmt(startHour),
      fastEndsAt: fmt(startHour + s.fastHours),
      eatingEndsAt: fmt(startHour + s.fastHours + s.eatHours)
    })),
    selected: profile.scheduleKey
  });
});

/* ------------------------------------------------------------------ */
/* Profile / settings                                                   */
/* ------------------------------------------------------------------ */
router.get('/profile', async (req, res) => {
  const profile = await TrackerProfile.getOrCreateFor(req.user.id);
  res.json({ profile });
});

router.put('/profile', async (req, res) => {
  try {
    const profile = await TrackerProfile.getOrCreateFor(req.user.id);
    const fields = [
      'scheduleKey', 'fastHours', 'eatHours', 'startHour', 'dailyGoalHours',
      'waterGoalMl', 'waterUnit', 'calorieGoal', 'proteinGoalG', 'carbGoalG', 'fatGoalG',
      'weeklySchedule', 'schedulePaused', 'reminders', 'goalFocus', 'dismissedTips'
    ];
    for (const f of fields) {
      if (req.body[f] !== undefined) profile[f] = req.body[f];
    }
    if (profile.fastHours + profile.eatHours > 24) {
      return res.status(400).json({ error: 'Fasting hours plus eating hours cannot exceed 24.' });
    }
    await profile.save();
    // Keep the shared water goal in step so the coached-side water UI agrees.
    if (req.body.waterGoalMl) { req.user.waterGoalMl = req.body.waterGoalMl; await req.user.save(); }
    res.json({ profile });
  } catch (err) {
    res.status(500).json({ error: 'Could not save settings', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Live state — the one call the dashboard polls                        */
/* ------------------------------------------------------------------ */
async function buildState(user, date) {
  const profile = await TrackerProfile.getOrCreateFor(user.id);
  const running = await TrackerSession.findOne({ where: { userId: user.id, status: 'running' } });

  let fast = null;
  if (running) {
    const elapsed = hoursBetween(running.startAt, new Date());
    const target = running.targetHours;
    const percent = Math.max(0, Math.min(100, Math.round((elapsed / target) * 100)));
    const stage = stageFor(elapsed);
    fast = {
      id: running.id,
      scheduleKey: running.scheduleKey,
      startAt: running.startAt,
      expectedEndAt: new Date(new Date(running.startAt).getTime() + target * 3600000),
      targetHours: target,
      eatingHours: running.eatingHours,
      elapsedHours: round1(elapsed),
      remainingHours: round1(Math.max(0, target - elapsed)),
      percent,
      reachedTarget: elapsed >= target,
      stage: { key: stage.key, name: stage.name, short: stage.short, detail: stage.detail, from: stage.from, to: stage.to }
    };
  }

  // An eating window that is currently open (set when a finished fast is
  // closed out with "start eating window").
  const eatingRow = await TrackerSession.findOne({
    where: { userId: user.id, eatingEndsAt: { [Op.gt]: new Date() }, eatingStartedAt: { [Op.ne]: null } },
    order: [['eatingStartedAt', 'DESC']]
  });
  let eating = null;
  if (eatingRow) {
    const total = hoursBetween(eatingRow.eatingStartedAt, eatingRow.eatingEndsAt);
    const done = hoursBetween(eatingRow.eatingStartedAt, new Date());
    eating = {
      startAt: eatingRow.eatingStartedAt,
      endsAt: eatingRow.eatingEndsAt,
      remainingHours: round1(Math.max(0, total - done)),
      percent: Math.max(0, Math.min(100, Math.round((done / total) * 100)))
    };
  }

  // Today's goal progress: completed fasting hours today + the live one.
  const todaysFasts = await TrackerSession.findAll({ where: { userId: user.id, localDate: date } });
  let goalHours = 0;
  for (const s of todaysFasts) {
    goalHours += s.status === 'running'
      ? hoursBetween(s.startAt, new Date())
      : (s.endAt ? hoursBetween(s.startAt, s.endAt) : 0);
  }
  const rest = await RestDay.findOne({ where: { userId: user.id, date } });

  return {
    profile,
    fast,
    eating,
    restDay: !!rest,
    dailyGoal: {
      targetHours: profile.dailyGoalHours,
      completedHours: round1(goalHours),
      percent: Math.min(100, Math.round((goalHours / profile.dailyGoalHours) * 100))
    }
  };
}

router.get('/state', async (req, res) => {
  try {
    res.json(await buildState(req.user, localDateOf(req)));
  } catch (err) {
    res.status(500).json({ error: 'Could not load tracker state', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Start / end / cancel a fast                                         */
/* ------------------------------------------------------------------ */
router.post('/start', async (req, res) => {
  try {
    const existing = await TrackerSession.findOne({ where: { userId: req.user.id, status: 'running' } });
    if (existing) {
      return res.status(409).json({
        error: 'You already have an active fast.',
        code: 'ACTIVE_FAST',
        session: existing
      });
    }
    const profile = await TrackerProfile.getOrCreateFor(req.user.id);
    const scheduleKey = req.body.scheduleKey || profile.scheduleKey;
    const preset = SCHEDULES.find(s => s.key === scheduleKey);
    const targetHours = parseFloat(req.body.targetHours) || (preset ? preset.fastHours : profile.fastHours);
    const eatingHours = parseFloat(req.body.eatingHours) || (preset ? preset.eatHours : profile.eatHours);
    if (!targetHours || targetHours <= 0 || targetHours > 72) {
      return res.status(400).json({ error: 'Target hours must be between 1 and 72.' });
    }

    // The client may back-date the start ("I actually stopped eating at 8pm").
    const startAt = req.body.startAt ? new Date(req.body.startAt) : new Date();
    if (isNaN(startAt)) return res.status(400).json({ error: 'Invalid start time' });
    if (startAt > new Date(Date.now() + 60000)) return res.status(400).json({ error: 'A fast cannot start in the future.' });

    const session = await TrackerSession.create({
      userId: req.user.id, startAt, targetHours, eatingHours, scheduleKey,
      status: 'running', localDate: req.body.date || isoDate(startAt)
    });
    res.status(201).json({ session, state: await buildState(req.user, session.localDate) });
  } catch (err) {
    res.status(500).json({ error: 'Could not start fast', detail: err.message });
  }
});

// Edit a running fast (start time and/or target).
router.patch('/session/:id', async (req, res) => {
  try {
    const session = await TrackerSession.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!session) return res.status(404).json({ error: 'Fast not found' });
    if (session.status !== 'running') return res.status(400).json({ error: 'Only a running fast can be edited.' });
    if (req.body.startAt) {
      const d = new Date(req.body.startAt);
      if (isNaN(d) || d > new Date(Date.now() + 60000)) return res.status(400).json({ error: 'Invalid start time' });
      session.startAt = d;
      session.localDate = req.body.date || isoDate(d);
    }
    if (req.body.targetHours) session.targetHours = parseFloat(req.body.targetHours);
    if (req.body.eatingHours) session.eatingHours = parseFloat(req.body.eatingHours);
    await session.save();
    res.json({ session, state: await buildState(req.user, localDateOf(req)) });
  } catch (err) {
    res.status(500).json({ error: 'Could not update fast', detail: err.message });
  }
});

router.post('/end', async (req, res) => {
  try {
    const session = await TrackerSession.findOne({ where: { userId: req.user.id, status: 'running' } });
    if (!session) return res.status(404).json({ error: 'No fast is running.' });

    session.endAt = new Date();
    const actual = hoursBetween(session.startAt, session.endAt);
    session.status = actual >= session.targetHours ? 'completed' : 'ended_early';
    if (typeof req.body.note === 'string') session.note = req.body.note;

    // Optionally roll straight into the eating window.
    if (req.body.startEatingWindow) {
      session.eatingStartedAt = session.endAt;
      session.eatingEndsAt = new Date(session.endAt.getTime() + (session.eatingHours || 8) * 3600000);
    }
    await session.save();

    res.json({
      session,
      summary: {
        targetHours: session.targetHours,
        actualHours: round1(actual),
        percent: Math.round((actual / session.targetHours) * 100),
        status: session.status
      },
      state: await buildState(req.user, localDateOf(req))
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not end fast', detail: err.message });
  }
});

// Called off without really running — kept out of the average/longest stats.
router.post('/cancel', async (req, res) => {
  try {
    const session = await TrackerSession.findOne({ where: { userId: req.user.id, status: 'running' } });
    if (!session) return res.status(404).json({ error: 'No fast is running.' });
    session.endAt = new Date();
    session.status = 'cancelled';
    await session.save();
    res.json({ session, state: await buildState(req.user, localDateOf(req)) });
  } catch (err) {
    res.status(500).json({ error: 'Could not cancel fast', detail: err.message });
  }
});

// Open the eating window for the most recently finished fast.
router.post('/eating/start', async (req, res) => {
  try {
    const session = await TrackerSession.findOne({
      where: { userId: req.user.id, status: { [Op.in]: ['completed', 'ended_early', 'broken'] } },
      order: [['endAt', 'DESC']]
    });
    if (!session) return res.status(404).json({ error: 'No finished fast to open an eating window for.' });
    const hours = parseFloat(req.body.eatingHours) || session.eatingHours || 8;
    session.eatingStartedAt = new Date();
    session.eatingEndsAt = new Date(Date.now() + hours * 3600000);
    await session.save();
    res.json({ state: await buildState(req.user, localDateOf(req)) });
  } catch (err) {
    res.status(500).json({ error: 'Could not start eating window', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* History                                                              */
/* ------------------------------------------------------------------ */
router.get('/history', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
  const rows = await TrackerSession.findAll({
    where: { userId: req.user.id, status: { [Op.ne]: 'running' } },
    order: [['startAt', 'DESC']], limit
  });
  const sessions = rows.map(s => {
    const actual = s.endAt ? hoursBetween(s.startAt, s.endAt) : 0;
    return {
      id: s.id, date: s.localDate || isoDate(s.startAt),
      startAt: s.startAt, endAt: s.endAt,
      scheduleKey: s.scheduleKey,
      targetHours: s.targetHours, actualHours: round1(actual),
      percent: s.targetHours ? Math.round((actual / s.targetHours) * 100) : 0,
      status: s.status === 'broken' ? 'ended_early' : s.status,
      note: s.note
    };
  });
  res.json({ sessions });
});

router.delete('/history/:id', async (req, res) => {
  const row = await TrackerSession.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  await row.destroy();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Statistics — week / month / all                                     */
/* ------------------------------------------------------------------ */
function streaksFrom(datesSet, today) {
  // Current streak walks back from today; a rest day neither breaks nor
  // extends it, so a planned day off doesn't punish the client.
  let current = 0;
  const cursor = new Date(today + 'T00:00:00');
  // don't break the streak just because today isn't finished yet
  if (!datesSet.fasted.has(today)) cursor.setDate(cursor.getDate() - 1);
  for (let i = 0; i < 400; i++) {
    const key = isoDate(cursor);
    if (datesSet.fasted.has(key)) current++;
    else if (!datesSet.rest.has(key)) break;
    cursor.setDate(cursor.getDate() - 1);
  }

  const all = [...datesSet.fasted].sort();
  let longest = 0, run = 0, prev = null;
  for (const key of all) {
    if (prev) {
      const gapDays = Math.round((new Date(key) - new Date(prev)) / 86400000);
      let bridged = gapDays === 1;
      if (!bridged && gapDays > 1) {
        // a run of rest days between two fasting days keeps the streak alive
        bridged = true;
        const c = new Date(prev);
        for (let i = 1; i < gapDays; i++) {
          c.setDate(c.getDate() + 1);
          if (!datesSet.rest.has(isoDate(c))) { bridged = false; break; }
        }
      }
      run = bridged ? run + 1 : 1;
    } else run = 1;
    longest = Math.max(longest, run);
    prev = key;
  }
  return { current, longest };
}

router.get('/stats', async (req, res) => {
  try {
    const today = localDateOf(req);
    const range = req.query.range || 'all'; // week | month | all
    const all = await TrackerSession.findAll({
      where: { userId: req.user.id, status: { [Op.ne]: 'running' } },
      order: [['startAt', 'ASC']]
    });
    const rests = await RestDay.findAll({ where: { userId: req.user.id } });

    const from = new Date(today + 'T00:00:00');
    if (range === 'week') from.setDate(from.getDate() - 6);
    else if (range === 'month') from.setDate(from.getDate() - 29);
    else from.setFullYear(from.getFullYear() - 50);
    const fromKey = isoDate(from);

    const inRange = all.filter(s => (s.localDate || isoDate(s.startAt)) >= fromKey);
    const counted = inRange.filter(s => s.status !== 'cancelled' && s.endAt);
    const durations = counted.map(s => hoursBetween(s.startAt, s.endAt));
    const completed = counted.filter(s => s.status === 'completed');

    const totalHours = durations.reduce((a, b) => a + b, 0);
    const fastedDates = new Set(all.filter(s => s.status === 'completed').map(s => s.localDate || isoDate(s.startAt)));
    const restDates = new Set(rests.map(r => r.date));
    const streak = streaksFrom({ fasted: fastedDates, rest: restDates }, today);

    const weekStart = new Date(today + 'T00:00:00');
    weekStart.setDate(weekStart.getDate() - 6);
    const thisWeek = [...fastedDates].filter(d => d >= isoDate(weekStart)).length;
    const monthStart = new Date(today + 'T00:00:00');
    monthStart.setDate(monthStart.getDate() - 29);
    const thisMonth = [...fastedDates].filter(d => d >= isoDate(monthStart)).length;

    res.json({
      range,
      totalFasts: inRange.length,
      completedFasts: completed.length,
      cancelledFasts: inRange.filter(s => s.status === 'cancelled').length,
      averageHours: durations.length ? round1(totalHours / durations.length) : 0,
      longestHours: durations.length ? round1(Math.max(...durations)) : 0,
      shortestHours: durations.length ? round1(Math.min(...durations)) : 0,
      completionRate: counted.length ? Math.round((completed.length / counted.length) * 100) : 0,
      totalHours: round1(totalHours),
      currentStreak: streak.current,
      longestStreak: streak.longest,
      daysThisWeek: thisWeek,
      daysThisMonth: thisMonth,
      restDays: [...restDates].filter(d => d >= fromKey).length
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load statistics', detail: err.message });
  }
});

// Last 7 local days of fasting hours, for the weekly bar chart.
router.get('/weekly', async (req, res) => {
  const today = localDateOf(req);
  const profile = await TrackerProfile.getOrCreateFor(req.user.id);
  const start = new Date(today + 'T00:00:00');
  start.setDate(start.getDate() - 6);
  const rows = await TrackerSession.findAll({
    where: { userId: req.user.id, localDate: { [Op.gte]: isoDate(start) }, status: { [Op.ne]: 'cancelled' } }
  });
  const rests = await RestDay.findAll({ where: { userId: req.user.id, date: { [Op.gte]: isoDate(start) } } });
  const restSet = new Set(rests.map(r => r.date));

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = isoDate(d);
    const hours = rows
      .filter(s => (s.localDate || isoDate(s.startAt)) === key)
      .reduce((sum, s) => sum + (s.endAt ? hoursBetween(s.startAt, s.endAt) : hoursBetween(s.startAt, new Date())), 0);
    days.push({ date: key, hours: round1(hours), restDay: restSet.has(key) });
  }
  const active = days.filter(d => d.hours > 0);
  res.json({
    days,
    goalHours: profile.dailyGoalHours,
    weeklyTargetHours: round1(profile.dailyGoalHours * 7),
    completedHours: round1(days.reduce((a, d) => a + d.hours, 0)),
    averageHours: active.length ? round1(active.reduce((a, d) => a + d.hours, 0) / active.length) : 0,
    completedFasts: active.length
  });
});

/* ------------------------------------------------------------------ */
/* Calendar                                                             */
/* ------------------------------------------------------------------ */
router.get('/calendar', async (req, res) => {
  const month = req.query.month || localDateOf(req).slice(0, 7); // YYYY-MM
  const first = `${month}-01`;
  const lastDate = new Date(new Date(first + 'T00:00:00').getFullYear(), new Date(first + 'T00:00:00').getMonth() + 1, 0);
  const last = isoDate(lastDate);

  const sessions = await TrackerSession.findAll({
    where: { userId: req.user.id, localDate: { [Op.between]: [first, last] } },
    order: [['startAt', 'ASC']]
  });
  const rests = await RestDay.findAll({ where: { userId: req.user.id, date: { [Op.between]: [first, last] } } });
  const restSet = new Set(rests.map(r => r.date));

  const byDate = {};
  for (const s of sessions) {
    const key = s.localDate || isoDate(s.startAt);
    const hours = s.endAt ? hoursBetween(s.startAt, s.endAt) : hoursBetween(s.startAt, new Date());
    if (!byDate[key]) byDate[key] = { date: key, hours: 0, sessions: [], status: 'none' };
    byDate[key].hours = round1(byDate[key].hours + hours);
    byDate[key].sessions.push({
      id: s.id, startAt: s.startAt, endAt: s.endAt,
      targetHours: s.targetHours, actualHours: round1(hours),
      status: s.status === 'broken' ? 'ended_early' : s.status
    });
  }
  for (const key of Object.keys(byDate)) {
    const st = byDate[key].sessions;
    byDate[key].status = st.some(s => s.status === 'running') ? 'active'
      : st.some(s => s.status === 'completed') ? 'completed'
      : st.some(s => s.status === 'ended_early') ? 'partial'
      : 'cancelled';
  }
  for (const key of restSet) {
    if (!byDate[key]) byDate[key] = { date: key, hours: 0, sessions: [], status: 'rest' };
    else byDate[key].restDay = true;
  }
  res.json({ month, days: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)) });
});

/* ---- Rest days ---- */
router.post('/rest-day', async (req, res) => {
  const date = req.body.date;
  if (!date) return res.status(400).json({ error: 'date is required' });
  const existing = await RestDay.findOne({ where: { userId: req.user.id, date } });
  if (existing) { await existing.destroy(); return res.json({ date, restDay: false }); }
  await RestDay.create({ userId: req.user.id, date, note: req.body.note });
  res.json({ date, restDay: true });
});

/* ------------------------------------------------------------------ */
/* Nutrition + meals                                                    */
/* ------------------------------------------------------------------ */
router.get('/nutrition', async (req, res) => {
  const date = localDateOf(req);
  const profile = await TrackerProfile.getOrCreateFor(req.user.id);
  const meals = await MealEntry.findAll({ where: { userId: req.user.id, date }, order: [['createdAt', 'ASC']] });

  const sum = (f) => Math.round(meals.reduce((a, m) => a + (m[f] || 0), 0) * 10) / 10;
  const byCategory = {};
  for (const c of ['breakfast', 'lunch', 'dinner', 'snack']) {
    const items = meals.filter(m => m.category === c);
    byCategory[c] = {
      items,
      calories: Math.round(items.reduce((a, m) => a + (m.calories || 0), 0))
    };
  }
  res.json({
    date, meals, byCategory,
    totals: { calories: sum('calories'), proteinG: sum('proteinG'), carbsG: sum('carbsG'), fatG: sum('fatG') },
    goals: {
      calories: profile.calorieGoal, proteinG: profile.proteinGoalG,
      carbsG: profile.carbGoalG, fatG: profile.fatGoalG
    }
  });
});

router.post('/meals', async (req, res) => {
  try {
    const { date, category, name } = req.body;
    if (!date || !category || !name) return res.status(400).json({ error: 'date, category and name are required' });
    const meal = await MealEntry.create({
      userId: req.user.id, date, category, name: String(name).trim(),
      quantity: req.body.quantity || null,
      calories: parseFloat(req.body.calories) || 0,
      proteinG: parseFloat(req.body.proteinG) || 0,
      carbsG: parseFloat(req.body.carbsG) || 0,
      fatG: parseFloat(req.body.fatG) || 0,
      notes: req.body.notes || null
    });
    res.status(201).json({ meal });
  } catch (err) {
    res.status(500).json({ error: 'Could not log meal', detail: err.message });
  }
});

router.patch('/meals/:id', async (req, res) => {
  const meal = await MealEntry.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!meal) return res.status(404).json({ error: 'Meal not found' });
  for (const f of ['category', 'name', 'quantity', 'calories', 'proteinG', 'carbsG', 'fatG', 'notes']) {
    if (req.body[f] !== undefined) meal[f] = req.body[f];
  }
  await meal.save();
  res.json({ meal });
});

router.delete('/meals/:id', async (req, res) => {
  const meal = await MealEntry.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!meal) return res.status(404).json({ error: 'Meal not found' });
  await meal.destroy();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Hydration                                                            */
/* ------------------------------------------------------------------ */
router.get('/water', async (req, res) => {
  const date = localDateOf(req);
  const profile = await TrackerProfile.getOrCreateFor(req.user.id);
  const start = new Date(date + 'T00:00:00'); start.setDate(start.getDate() - 29);

  const entries = await TrackerWaterEntry.findAll({
    where: { userId: req.user.id, localDate: { [Op.gte]: isoDate(start) } },
    order: [['at', 'ASC']]
  });
  const byDate = {};
  for (const e of entries) {
    const key = e.localDate || isoDate(e.at);
    byDate[key] = (byDate[key] || 0) + e.ml;
  }
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(date + 'T00:00:00'); d.setDate(d.getDate() - i);
    const key = isoDate(d);
    last7.push({ date: key, ml: byDate[key] || 0 });
  }
  const values = Object.values(byDate);
  const bestKey = Object.keys(byDate).sort((a, b) => byDate[b] - byDate[a])[0] || null;
  const todayMl = byDate[date] || 0;
  const yKey = isoDate(new Date(new Date(date + 'T00:00:00').getTime() - 86400000));

  res.json({
    date,
    goalMl: profile.waterGoalMl,
    unit: profile.waterUnit,
    todayMl,
    remainingMl: Math.max(0, profile.waterGoalMl - todayMl),
    percent: Math.min(100, Math.round((todayMl / profile.waterGoalMl) * 100)),
    yesterdayMl: byDate[yKey] || 0,
    weeklyAverageMl: last7.length ? Math.round(last7.reduce((a, d) => a + d.ml, 0) / 7) : 0,
    monthlyAverageMl: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0,
    bestDay: bestKey ? { date: bestKey, ml: byDate[bestKey] } : null,
    last7,
    todayEntries: entries.filter(e => (e.localDate || isoDate(e.at)) === date)
  });
});

router.post('/water', async (req, res) => {
  const ml = Math.round(parseFloat(req.body.ml));
  if (!ml) return res.status(400).json({ error: 'ml is required' });
  const date = req.body.date || isoDate(new Date());
  // A negative value is the "−" button undoing the last add.
  const entry = await TrackerWaterEntry.create({ userId: req.user.id, ml, localDate: date });
  res.status(201).json({ entry });
});

router.delete('/water/:id', async (req, res) => {
  const entry = await TrackerWaterEntry.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  await entry.destroy();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Daily tasks                                                          */
/* ------------------------------------------------------------------ */
router.get('/tasks', async (req, res) => {
  const date = localDateOf(req);
  const done = await TrackerTaskLog.findAll({ where: { userId: req.user.id, date } });
  const doneKeys = new Set(done.map(d => d.taskKey));
  res.json({
    date,
    tasks: DAILY_TASKS.map(t => ({ ...t, done: doneKeys.has(t.key) })),
    completed: doneKeys.size,
    total: DAILY_TASKS.length
  });
});

router.post('/tasks/:key', async (req, res) => {
  const date = req.body.date || isoDate(new Date());
  const key = req.params.key;
  if (!DAILY_TASKS.some(t => t.key === key)) return res.status(404).json({ error: 'Unknown task' });
  const existing = await TrackerTaskLog.findOne({ where: { userId: req.user.id, date, taskKey: key } });
  if (existing) { await existing.destroy(); return res.json({ key, done: false }); }
  await TrackerTaskLog.create({ userId: req.user.id, date, taskKey: key });
  res.json({ key, done: true });
});

/* ------------------------------------------------------------------ */
/* Dashboard roll-up — one call for the tracker home page              */
/* ------------------------------------------------------------------ */
router.get('/dashboard', async (req, res) => {
  try {
    const date = localDateOf(req);
    const state = await buildState(req.user, date);
    const profile = state.profile;

    const meals = await MealEntry.findAll({ where: { userId: req.user.id, date } });
    const calories = Math.round(meals.reduce((a, m) => a + (m.calories || 0), 0));

    const waterRows = await TrackerWaterEntry.findAll({ where: { userId: req.user.id, localDate: date } });
    const waterMl = waterRows.reduce((a, e) => a + e.ml, 0);

    const doneTasks = await TrackerTaskLog.count({ where: { userId: req.user.id, date } });

    const weights = await WeightLog.findAll({ where: { userId: req.user.id }, order: [['date', 'DESC']], limit: 2 });

    res.json({
      date,
      state,
      tipOfDay: tipForDate(date),
      nutrition: { calories, goal: profile.calorieGoal, mealCount: meals.length },
      water: { ml: waterMl, goalMl: profile.waterGoalMl, unit: profile.waterUnit },
      tasks: { completed: doneTasks, total: DAILY_TASKS.length },
      weight: weights.length ? {
        currentKg: weights[0].weightKg,
        previousKg: weights[1] ? weights[1].weightKg : null,
        changeKg: weights[1] ? round1(weights[0].weightKg - weights[1].weightKg) : null
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load tracker dashboard', detail: err.message });
  }
});

module.exports = router;
