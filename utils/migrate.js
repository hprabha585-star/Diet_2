// Create/refresh all MySQL tables from the Sequelize models.
//   node utils/migrate.js
//
// You normally DON'T need this any more: the app itself notices when
// models/index.js has changed (it stores a fingerprint of the schema in
// the app_meta table) and syncs once on the next cold start. Run this to
// force a sync by hand — e.g. against Aiven from your own PC with the
// Aiven values in .env. Back up the database first on production data.
require('dotenv').config();
process.env.DB_FORCE_SYNC = 'true';
const { ensureDb } = require('./dbLifecycle');

ensureDb()
  .then(() => { console.log('All tables created/updated in MySQL.'); process.exit(0); })
  .catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
