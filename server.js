require('dotenv').config();
const path = require('path');
const express = require('express');
const { connectDB, sequelize } = require('./config/db');

const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/client');
const adminRoutes = require('./routes/admin');
const { Plan } = require('./models');

const app = express();

app.use(express.json({ limit: '6mb' })); // roomy enough for a base64 payment screenshot

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'fastcoach-backend' }));

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
  // sync() only creates tables that don't exist yet — it's safe to run on
  // every boot. Use `npm run migrate` for an explicit one-off setup, or
  // `sequelize.sync({ alter: true })` locally if you change a model shape.
  await sequelize.sync();
  app.listen(PORT, () => console.log(`FastCoach API running on port ${PORT}`));
});
