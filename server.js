require('dotenv').config();
const path = require('path');
const express = require('express');
const { connectDB, sequelize } = require('./config/db');

const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/client');
const adminRoutes = require('./routes/admin');
const trackerRoutes = require('./routes/tracker');
const { Plan } = require('./models');

const app = express();

app.use(express.json({ limit: '6mb' })); // roomy enough for a base64 payment screenshot

// /api/health checks the database with a REAL query (not just a table-name
// lookup, which can misreport on hosts that case-fold table names) so you
// can diagnose a broken deploy from a browser tab — no SSH needed.
// Visit yourdomain.com/api/health directly.
app.get('/api/health', async (req, res) => {
  const result = { ok: true, service: 'fastcoach-backend' };
  try {
    await sequelize.authenticate();
    result.database = 'connected';
  } catch (err) {
    return res.status(500).json({ ok: false, service: 'fastcoach-backend', database: 'NOT connected', error: err.message });
  }
  try {
    const { User } = require('./models');
    const count = await User.count();
    result.tablesCreated = true;
    result.userCount = count;
    result.adminCount = await User.count({ where: { role: 'admin' } });
    // Counts, not identities — flags rows whose password could never pass
    // bcrypt.compare (e.g. someone was typed straight into MySQL instead of
    // going through registration/bootstrap). This is the #1 cause of a
    // 500 on login that otherwise looks like a working deploy.
    const BCRYPT_PATTERN = /^\$2[aby]\$\d{2}\$/;
    const all = await User.findAll({ attributes: ['passwordHash'] });
    result.usersWithBrokenPassword = all.filter(u => !BCRYPT_PATTERN.test(u.passwordHash || '')).length;
  } catch (err) {
    result.tablesCreated = false;
    result.tableError = err.message; // e.g. "Table 'xxx.Users' doesn't exist"
  }
  res.json(result);
});

// Public: the plans shown on the landing page's pricing section
// (includes both 55-day protocol plans and Fasting Tracker plans).
app.get('/api/plans', async (req, res) => {
  try {
    let plans = await Plan.findAll({ where: { active: true }, order: [['order', 'ASC'], ['priceInr', 'ASC']] });
    if (!plans.length) {
      await Plan.bulkCreate(Plan.DEFAULTS);
      plans = await Plan.findAll({ where: { active: true }, order: [['order', 'ASC'], ['priceInr', 'ASC']] });
    }
    res.json({ plans });
  } catch (err) {
    res.status(500).json({ error: 'Could not load plans' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/admin', adminRoutes);
// Fasting Tracker (tracker-mode plans only) — its own router so the
// coached client routes stay untouched.
app.use('/api/tracker', trackerRoutes);

// Hostinger runs one Node app — the frontend is served from the same
// process, same origin, so there is no CORS/CLIENT_ORIGIN config anymore
// and no separate config.js API base URL to keep in sync.
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

connectDB().then(async () => {
  try {
    // sync() creates any table that doesn't exist yet — safe to run on
    // every boot. Logged explicitly here so a failure shows up in
    // Hostinger's Runtime logs instead of failing silently.
    await sequelize.sync();
    console.log('Database tables verified/created.');
  } catch (err) {
    console.error('sequelize.sync() failed — tables were NOT created:', err.message);
  }
  app.listen(PORT, () => console.log(`FastCoach API running on port ${PORT}`));
});
