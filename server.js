require('dotenv').config();
const path = require('path');
const express = require('express');
const { connectDB, sequelize } = require('./config/db');

const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/client');
const adminRoutes = require('./routes/admin');
const trackerRoutes = require('./routes/tracker');

const app = express();

// ------------------------------------------------------------------
// Never let one bad request or one bad promise take the whole Node
// process down. Without this, an uncaught error anywhere (a typo in a
// route, a missing await, whatever) can silently kill the process on
// shared hosting like Hostinger — and the symptom looks EXACTLY like
// what you saw: every single /api/* call returning 503, because the
// app just isn't running anymore, with nothing in the browser telling
// you why. Log it and keep serving.
// ------------------------------------------------------------------
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (app keeps running):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (app keeps running):', err);
});

app.use(express.json({ limit: '6mb' })); // roomy enough for a base64 payment screenshot

// Tracks whether the database is actually reachable right now. Read by
// the /api guard below and by /api/health. Starts false and flips to
// true only after a real, successful connection.
let dbReady = false;
let dbError = null;

// Every /api/* route except /api/health needs the database. Instead of
// each route crashing with a raw, confusing 500 (or the request just
// hanging) when the DB is down, this returns one clear, consistent
// error immediately — so a misconfigured DB_HOST/DB_USER/DB_PASSWORD
// shows up as a readable message in the browser's Network tab instead
// of a mysterious 503 on every page.
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/plans') return next();
  if (!dbReady) {
    return res.status(503).json({
      error: 'Database is not connected yet',
      detail: dbError ? dbError.message : 'Still starting up — try again in a few seconds.'
    });
  }
  next();
});

// /api/health always works, even with the database down, and always
// tells you the truth about what's wrong. Visit yourdomain.com/api/health
// directly in a browser any time something looks broken — no SSH needed.
app.get('/api/health', async (req, res) => {
  const result = { ok: true, service: 'fastcoach-backend' };
  if (!dbReady) {
    return res.status(200).json({
      ok: false,
      service: 'fastcoach-backend',
      database: 'NOT connected',
      error: dbError ? dbError.message : 'unknown',
      hint: 'Check DB_HOST, DB_NAME, DB_USER and DB_PASSWORD in your Node app\'s Environment Variables panel (hPanel -> Databases -> MySQL Databases has the exact values), then restart the app. No terminal/SSH needed.'
    });
  }
  try {
    await sequelize.authenticate();
    result.database = 'connected';
  } catch (err) {
    return res.status(200).json({ ok: false, service: 'fastcoach-backend', database: 'NOT connected', error: err.message });
  }
  try {
    const { User } = require('./models');
    const count = await User.count();
    result.tablesCreated = true;
    result.userCount = count;
    result.adminCount = await User.count({ where: { role: 'admin' } });
    const BCRYPT_PATTERN = /^\$2[aby]\$\d{2}\$/;
    const all = await User.findAll({ attributes: ['passwordHash'] });
    result.usersWithBrokenPassword = all.filter(u => !BCRYPT_PATTERN.test(u.passwordHash || '')).length;
  } catch (err) {
    result.tablesCreated = false;
    result.tableError = err.message;
  }
  res.json(result);
});

// Public: the plans shown on the landing page's pricing section.
app.get('/api/plans', async (req, res) => {
  if (!dbReady) return res.json({ plans: [] }); // landing page still loads even if DB is down
  try {
    const { Plan } = require('./models');
    let plans = await Plan.findAll({ where: { active: true }, order: [['order', 'ASC'], ['priceInr', 'ASC']] });
    if (!plans.length) {
      await Plan.bulkCreate(Plan.DEFAULTS);
      plans = await Plan.findAll({ where: { active: true }, order: [['order', 'ASC'], ['priceInr', 'ASC']] });
    }
    res.json({ plans });
  } catch (err) {
    res.status(500).json({ error: 'Could not load plans', detail: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/tracker', trackerRoutes);

// Hostinger runs one Node app — the frontend is served from the same
// process, same origin.
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

const PORT = process.env.PORT || 5000;

// ------------------------------------------------------------------
// Boot sequence. THE KEY CHANGE: app.listen() always runs, no matter
// what happens above it. A database problem now means "the site loads,
// login shows a clear error, /api/health explains exactly what's
// wrong" instead of "the entire site is 503 with zero information."
//
// sync({ alter: true }) runs automatically on every single boot, so
// there is no separate `npm run migrate` step to run over SSH ever
// again — restarting the app from hPanel (a button, not a terminal)
// is enough to pick up any model/column change.
// ------------------------------------------------------------------
app.listen(PORT, () => console.log(`FastCoach API listening on port ${PORT}`));

(async () => {
  try {
    await connectDB();
    dbReady = true;
    console.log('MySQL connected');
  } catch (err) {
    dbError = err;
    console.error('MySQL connection FAILED — the site will still load, but every /api call will');
    console.error('return a clear 503 until this is fixed. Check DB_HOST / DB_NAME / DB_USER / DB_PASSWORD.');
    console.error('Underlying error:', err.message);
    return; // don't attempt sync() against a database we can't reach
  }
  try {
    require('./models'); // registers all tables + associations
    await sequelize.sync({ alter: true });
    console.log('Database tables verified/created/updated automatically — no manual migrate needed.');
  } catch (err) {
    console.error('Automatic table sync failed (site still runs; API calls will 500 with this detail):', err.message);
  }
})();
