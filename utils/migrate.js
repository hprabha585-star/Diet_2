// Create/refresh all MySQL tables from the Sequelize models.
//   node utils/migrate.js
//
// Uses { alter: true }: plain sync() only creates tables that are
// MISSING, so it would never add the new Fasting Tracker columns to a
// TrackerSession table that already exists. alter compares each model
// against the live table and adds what's missing. Back up the database
// before running it on production data.
require('dotenv').config();
const { sequelize } = require('../config/db');
require('../models');

(async () => {
  await sequelize.authenticate();
  await sequelize.sync({ alter: true });
  console.log('All tables created/updated in MySQL.');
  process.exit(0);
})();
