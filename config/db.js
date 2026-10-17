const { Sequelize } = require('sequelize');

/* ------------------------------------------------------------------ */
/* MySQL connection — tuned for Vercel serverless + Aiven free tier.   */
/*                                                                      */
/* - Small pool: every serverless instance gets its own pool, and the   */
/*   Aiven free plan only allows a handful of connections in total.     */
/* - Short connect timeout: when Aiven is powered off, fail fast (and   */
/*   trigger the auto power-on in utils/dbLifecycle.js) instead of      */
/*   hanging until Vercel kills the function.                           */
/* - SSL on by default (Aiven requires it). Set DB_SSL=false for a      */
/*   local MySQL. Set DB_CA_CERT to Aiven's CA certificate (the text    */
/*   of ca.pem, from the Aiven console) to verify the server properly.  */
/* ------------------------------------------------------------------ */

const sslEnabled = String(process.env.DB_SSL || 'true').toLowerCase() !== 'false';
const caCert = process.env.DB_CA_CERT ? process.env.DB_CA_CERT.replace(/\\n/g, '\n') : null;

const sequelize = new Sequelize(
  process.env.DB_NAME || 'defaultdb',
  process.env.DB_USER || 'avnadmin',
  process.env.DB_PASSWORD || '',
  {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    dialect: 'mysql',
    logging: false,
    define: { underscored: true, timestamps: true },
    dialectOptions: {
      connectTimeout: 10000,
      ...(sslEnabled ? { ssl: caCert ? { ca: caCert, rejectUnauthorized: true } : { rejectUnauthorized: false } } : {})
    },
    pool: { max: 3, min: 0, acquire: 15000, idle: 5000, evict: 5000 },
    // Retry a query once if the database dropped an idle connection while
    // the function was frozen between requests. Deliberately NOT retrying
    // connect timeouts — a powered-off database should fail fast.
    retry: {
      max: 2,
      match: [/ECONNRESET/, /EPIPE/, /PROTOCOL_CONNECTION_LOST/]
    }
  }
);

async function connectDB() {
  try {
    await sequelize.authenticate();
    console.log('MySQL connected');
  } catch (err) {
    console.error('MySQL connection error:', err.message);
    if (process.env.NODE_ENV !== 'production') process.exit(1);
    throw err;
  }
}

module.exports = { sequelize, connectDB };
