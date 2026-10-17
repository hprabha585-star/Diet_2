require('dotenv').config();
const path = require('path');
const express = require('express');
const { ensureDb, ensureDbFresh, keepAlive, wakeAiven, aivenConfigured } = require('./utils/dbLifecycle');

const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/client');
const adminRoutes = require('./routes/admin');
const trackerRoutes = require('./routes/tracker');
const { Plan, Settings } = require('./models');

// Safety net against unhandled rejections
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const app = express();

// 12mb: an 8MB PDF brochure is ~10.7MB once base64-encoded.
app.use(express.json({ limit: '12mb' }));

/* ------------------------------------------------------------------ */
/* Keep-alive — hit this every 10–30 minutes from an external pinger    */
/* (cron-job.org / GitHub Actions) and once a day from Vercel Cron.     */
/* It does a real DB write so Aiven sees activity, and if the database  */
/* is down it asks the Aiven API to power it back on.                   */
/*                                                                      */
/* Protected by CRON_SECRET: send it as "Authorization: Bearer <secret>"*/
/* (Vercel Cron does this automatically) or as ?key=<secret>.           */
/* ------------------------------------------------------------------ */
app.get('/api/keepalive', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.key;
    if (given !== secret) return res.status(401).json({ ok: false, error: 'Bad or missing key' });
  }
  const started = Date.now();
  try {
    const result = await keepAlive();
    res.json({ ok: true, database: 'up', ms: Date.now() - started, ...result });
  } catch (err) {
    const wake = await wakeAiven();
    // 503 so the pinger's dashboard shows the failure clearly.
    res.status(503).json({ ok: false, database: 'down', error: err.message, wake });
  }
});

// /api/health checks the database with a REAL query
app.get('/api/health', async (req, res) => {
  const result = { ok: true, service: 'fastcoach-backend' };
  try {
    await ensureDb();
    result.database = 'connected';
  } catch (err) {
    const wake = await wakeAiven();
    return res.status(503).json({ ok: false, service: 'fastcoach-backend', database: 'NOT connected', error: err.message, wake });
  }
  try {
    const { User } = require('./models');
    result.tablesCreated = true;
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

// Every other /api route needs the database. Wait for it (cheap after the
// first request on an instance); if it's unreachable, try to wake Aiven
// and tell the browser plainly instead of throwing a raw 500.
app.use('/api', async (req, res, next) => {
  try {
    await ensureDbFresh();
    next();
  } catch (err) {
    console.error('Database unavailable:', err.message);
    const wake = await wakeAiven();
    res.status(503).json({
      error: wake.attempted && !wake.error
        ? 'The database was asleep and is starting up. Please try again in 2–3 minutes.'
        : 'The database is unavailable right now. Please try again in a minute.',
      detail: err.message,
      waking: !!(wake.attempted && !wake.error)
    });
  }
});

// Public: plans on landing page. The PDF brochures are left out — they can
// be several MB each and were being downloaded on every landing-page visit.
app.get('/api/plans', async (req, res) => {
  try {
    const opts = {
      where: { active: true },
      order: [['order', 'ASC'], ['priceInr', 'ASC']],
      attributes: { exclude: ['brochurePdfBase64'] }
    };
    let plans = await Plan.findAll(opts);
    if (!plans.length) {
      await Plan.bulkCreate(Plan.DEFAULTS);
      plans = await Plan.findAll(opts);
    }
    res.json({ plans });
  } catch (err) {
    res.status(500).json({ error: 'Could not load plans', detail: err.message });
  }
});

// Public: website name + logo
app.get('/api/site-settings', async (req, res) => {
  try {
    const settings = await Settings.getOrCreate();
    res.json({ siteName: settings.siteName || 'FastCoach', logoBase64: settings.logoBase64 || null });
  } catch (err) {
    res.json({ siteName: 'FastCoach', logoBase64: null });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/tracker', trackerRoutes);

// Static frontend serving
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That upload is too large', detail: 'Keep PDFs under 8MB and images under 1.5MB.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Export app for Vercel Serverless deployment
module.exports = app;

if (process.env.VERCEL) {
  // Serverless: warm the connection on cold start without blocking module load.
  ensureDb().catch(() => {});
} else {
  // Local / any normal Node host: start a server.
  const PORT = process.env.PORT || 5000;
  ensureDb()
    .then(() => console.log('Database ready.'))
    .catch(err => console.error('Database not ready yet (requests will retry):', err.message))
    .finally(() => app.listen(PORT, () => console.log(`FastCoach running on http://localhost:${PORT}  (Aiven auto-wake ${aivenConfigured() ? 'ON' : 'off'})`)));
}
