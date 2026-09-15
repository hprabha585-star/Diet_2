// Seeds (or re-seeds) the 55-day master protocol into MongoDB.
//   node utils/seedProtocol.js          -> only inserts days that don't exist
//   node utils/seedProtocol.js --force  -> overwrites every day with the defaults
require('dotenv').config();
const connectDB = require('../config/db');
const ProtocolDay = require('../models/ProtocolDay');
const { PROTOCOL_DAYS } = require('./protocolData');

(async () => {
  await connectDB();
  const force = process.argv.includes('--force');
  let inserted = 0, updated = 0, skipped = 0;

  for (const d of PROTOCOL_DAYS) {
    const existing = await ProtocolDay.findOne({ day: d.day });
    if (!existing) {
      await ProtocolDay.create({ ...d, updatedAt: new Date() });
      inserted++;
    } else if (force) {
      await ProtocolDay.updateOne({ day: d.day }, { ...d, updatedAt: new Date() });
      updated++;
    } else {
      skipped++;
    }
  }

  console.log(`Protocol seed complete — ${inserted} inserted, ${updated} overwritten, ${skipped} left as-is.`);
  if (skipped && !force) console.log('Run with --force to reset coach edits back to the defaults.');
  process.exit(0);
})();
