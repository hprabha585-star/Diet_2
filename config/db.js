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
    define: { underscored: true, timestamps: true },
    // Shared hosting MySQL (Hostinger included) usually caps how many
    // connections one account can hold open at once — often in the
    // single digits. Made explicit here so several dashboard panels
    // loading at once queue cleanly for a free connection instead of
    // each one quietly assuming it has its own. `acquire` is how long a
    // request waits for a free connection before failing with a clear
    // error, instead of the page just looking stuck with no explanation.
    pool: { max: 5, min: 0, acquire: 20000, idle: 10000 }
  }
);

async function connectDB() {
  try {
    await sequelize.authenticate();
    console.log('MySQL connected');
  } catch (err) {
    console.error('MySQL connection error:', err.message);
    process.exit(1);
  }
}

module.exports = { sequelize, connectDB };
