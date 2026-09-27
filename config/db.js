const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME || 'fastcoach',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    logging: false,
    define: { underscored: true, timestamps: true }
  }
);

/**
 * IMPORTANT: this used to call process.exit(1) the moment MySQL auth
 * failed. On Hostinger that turns one wrong environment variable (a very
 * common first-deploy mistake — DB_HOST isn't always "localhost", and
 * DB_USER is usually prefixed like "u123456789_dbuser", not "root") into
 * the ENTIRE app going down: every single /api/* route 503s, forever,
 * with no clue why, because the Node process itself was never running.
 *
 * Now this only ever THROWS. server.js decides what to do with that —
 * and it keeps the app running either way, so /api/health can always
 * tell you the real reason instead of a blank 503.
 */
async function connectDB() {
  await sequelize.authenticate();
}

module.exports = { sequelize, connectDB };
