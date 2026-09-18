// One-off: create all MySQL tables from the Sequelize models.
//   node utils/migrate.js
require('dotenv').config();
const { sequelize } = require('../config/db');
require('../models');

(async () => {
  await sequelize.authenticate();
  await sequelize.sync();
  console.log('All tables created/verified in MySQL.');
  process.exit(0);
})();
