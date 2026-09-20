// One-off: recompute points and streaks for EVERY coached client from
// their checklist rows. Run this once after deploying the scoring fix —
// it cleans up totals the old `points += 100` code banked incorrectly
// (e.g. 100 points on day 1 for ticking the only meal that existed).
//   node utils/rescoreAll.js
require('dotenv').config();
const { sequelize } = require('../config/db');
const { User, ChecklistLog } = require('../models');
const { rescoreDay, recalcUserScore } = require('./scoring');

(async () => {
  await sequelize.authenticate();
  const clients = await User.findAll({ where: { role: 'client', planMode: 'protocol' } });

  for (const user of clients) {
    const before = { points: user.points, streak: user.streakCurrent, best: user.streakBest };
    const logs = await ChecklistLog.findAll({ where: { userId: user.id }, attributes: ['day'] });
    for (const log of logs) await rescoreDay(user.id, log.day);
    const after = await recalcUserScore(user);
    const changed = before.points !== after.points || before.streak !== after.streakCurrent || before.best !== after.streakBest;
    console.log(
      `${changed ? 'FIXED  ' : 'ok     '} ${user.email}: ` +
      `points ${before.points} -> ${after.points}, ` +
      `streak ${before.streak} -> ${after.streakCurrent}, ` +
      `best ${before.best} -> ${after.streakBest}`
    );
  }
  console.log(`\nDone — ${clients.length} client(s) checked.`);
  process.exit(0);
})();