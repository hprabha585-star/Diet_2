/* ============================================================
   Database lifecycle for Vercel (serverless) + Aiven (free tier).

   Three problems this solves:

   1. SLOW COLD STARTS. The old server.js ran sequelize.sync({ alter: true })
      on EVERY cold start — dozens of ALTER/SHOW queries across ~25 tables
      — and didn't even wait for it before serving requests. Now we hash
      the model definitions and only sync when that hash differs from the
      one stored in the database. A normal cold start costs one tiny query.

   2. AIVEN POWERING OFF. Aiven powers free services off when it sees no
      ongoing activity. keepAlive() does a real read + write so there is
      genuine activity; it's called by /api/keepalive, which external
      pingers (cron-job.org, GitHub Actions, Vercel Cron) hit regularly.

   3. MANUAL POWER-ON. If the database is unreachable and AIVEN_API_TOKEN,
      AIVEN_PROJECT and AIVEN_SERVICE are set, wakeAiven() asks the Aiven
      API to power the service back on — no one has to log in to the
      console. It takes a few minutes to come back.
   ============================================================ */
const crypto = require('crypto');
const { sequelize } = require('../config/db');

const META_TABLE = 'app_meta';

/* ---------------- schema hash ---------------- */
function typeString(type) {
  try { return String(type.toSql ? type.toSql() : type); } catch (e) { return type && type.key ? type.key : String(type); }
}

// A fingerprint of every model's columns + indexes. Any change to
// models/index.js changes this, which triggers exactly one sync on the
// next cold start — no manual "remember to run migrate" step.
function schemaHash() {
  const models = Object.values(sequelize.models).sort((a, b) => a.name.localeCompare(b.name));
  const shape = models.map(m => ({
    name: m.name,
    attrs: Object.entries(m.rawAttributes).sort(([a], [b]) => a.localeCompare(b)).map(([k, a]) => [
      k, typeString(a.type), a.allowNull !== false, !!a.unique, !!a.primaryKey,
      a.defaultValue === undefined ? null : JSON.stringify(a.defaultValue instanceof Object && a.defaultValue.key ? a.defaultValue.key : a.defaultValue)
    ]),
    indexes: (m.options.indexes || []).map(i => JSON.stringify(i))
  }));
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

async function ensureMetaTable() {
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
       k VARCHAR(64) PRIMARY KEY,
       v TEXT,
       updated_at DATETIME NOT NULL
     )`
  );
}

async function getMeta(key) {
  const [rows] = await sequelize.query(`SELECT v FROM ${META_TABLE} WHERE k = ?`, { replacements: [key] });
  return rows.length ? rows[0].v : null;
}

async function setMeta(key, value) {
  await sequelize.query(
    `INSERT INTO ${META_TABLE} (k, v, updated_at) VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = NOW()`,
    { replacements: [key, value] }
  );
}

/* ---------------- one-time-per-instance init ---------------- */
let readyPromise = null;

async function init() {
  require('../models'); // registers every model on `sequelize`
  await sequelize.authenticate();
  await ensureMetaTable();

  const wanted = schemaHash();
  const current = await getMeta('schema_hash');
  if (current === wanted && process.env.DB_FORCE_SYNC !== 'true') return { synced: false };

  // Schema changed (or fresh database). A MySQL named lock makes sure two
  // cold-starting instances don't both run ALTER TABLE at the same time.
  const [[lock]] = await sequelize.query(`SELECT GET_LOCK('fastcoach_schema_sync', 60) AS got`);
  try {
    if (!lock || Number(lock.got) !== 1) throw new Error('Could not get the schema-sync lock');
    // Re-check: another instance may have finished while we waited.
    if ((await getMeta('schema_hash')) !== wanted || process.env.DB_FORCE_SYNC === 'true') {
      console.log('Syncing tables to match models/index.js…');
      await sequelize.sync({ alter: true });
      // One-time data repair that used to run on every boot.
      const { backfillDualPlanAccess } = require('./backfillAccess');
      await backfillDualPlanAccess();
      await setMeta('schema_hash', wanted);
      console.log('Schema sync complete.');
    }
  } finally {
    await sequelize.query(`SELECT RELEASE_LOCK('fastcoach_schema_sync')`).catch(() => {});
  }
  return { synced: true };
}

/** Resolves once the DB is reachable and the schema is current. Retries on the next call if it failed. */
function ensureDb() {
  if (!readyPromise) {
    readyPromise = init()
      .then(r => { lastOkAt = Date.now(); return r; })
      .catch(err => { readyPromise = null; throw err; });
  }
  return readyPromise;
}

/**
 * ensureDb() plus a cheap "SELECT 1" if this warm instance hasn't talked
 * to the database in the last 30s — so a database that went down AFTER
 * the instance started is noticed (and woken) instead of every route
 * failing with a raw 500.
 */
let lastOkAt = 0;
async function ensureDbFresh() {
  await ensureDb();
  if (Date.now() - lastOkAt < 30000) return;
  try {
    await sequelize.query('SELECT 1');
    lastOkAt = Date.now();
  } catch (err) {
    readyPromise = null; // re-run init (and schema check) once it's back
    throw err;
  }
}

/* ---------------- keep-alive ---------------- */
async function keepAlive() {
  await ensureDb();
  // A real write + read, so the database sees genuine activity, not just
  // an open socket.
  await setMeta('keepalive', new Date().toISOString());
  const { User } = require('../models');
  const users = await User.count();
  return { users, at: await getMeta('keepalive') };
}

/* ---------------- Aiven auto power-on ---------------- */
let lastWakeAttempt = 0;

function aivenConfigured() {
  return !!(process.env.AIVEN_API_TOKEN && process.env.AIVEN_PROJECT && process.env.AIVEN_SERVICE);
}

async function aivenFetch(method, body) {
  const url = `https://api.aiven.io/v1/project/${encodeURIComponent(process.env.AIVEN_PROJECT)}/service/${encodeURIComponent(process.env.AIVEN_SERVICE)}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `aivenv1 ${process.env.AIVEN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Aiven API ${res.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/**
 * If the Aiven service is powered off, power it on. Throttled to one
 * attempt per minute per instance so a burst of failing requests doesn't
 * hammer the Aiven API. Never throws — returns what happened.
 */
async function wakeAiven() {
  if (!aivenConfigured()) return { attempted: false, reason: 'AIVEN_API_TOKEN / AIVEN_PROJECT / AIVEN_SERVICE not set' };
  if (Date.now() - lastWakeAttempt < 60000) return { attempted: false, reason: 'throttled' };
  lastWakeAttempt = Date.now();
  try {
    const { service } = await aivenFetch('GET');
    const state = service && service.state;
    if (state === 'RUNNING') return { attempted: false, state, reason: 'service is already running' };
    if (state === 'REBUILDING' || state === 'REBALANCING') return { attempted: false, state, reason: 'service is already starting' };
    await aivenFetch('PUT', { powered: true });
    console.log(`Aiven service was ${state} — power-on requested.`);
    return { attempted: true, previousState: state };
  } catch (err) {
    console.error('Aiven wake failed:', err.message);
    return { attempted: true, error: err.message };
  }
}

module.exports = { ensureDb, ensureDbFresh, keepAlive, wakeAiven, schemaHash, aivenConfigured };
