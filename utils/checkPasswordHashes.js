// One-off diagnostic: finds any user whose passwordHash is NOT a valid
// bcrypt hash — happens if a row is inserted straight into MySQL instead
// of via /api/auth/register or the admin "create client" form.
//   node utils/checkPasswordHashes.js
require('dotenv').config();
const { sequelize } = require('../config/db');
const { User } = require('../models');

const BCRYPT_PATTERN = /^\$2[aby]\$\d{2}\$/;

(async () => {
  await sequelize.authenticate();
  const users = await User.findAll({ attributes: ['id', 'name', 'email', 'passwordHash', 'role'] });
  const broken = users.filter(u => !BCRYPT_PATTERN.test(u.passwordHash || ''));

  if (broken.length === 0) {
    console.log(`Checked ${users.length} users — all passwords are properly hashed.`);
  } else {
    console.log(`Checked ${users.length} users — ${broken.length} have an invalid (non-bcrypt) password and CANNOT log in:`);
    broken.forEach(u => console.log(`  - ${u.name} <${u.email}> (${u.role}) — id: ${u.id}`));
    console.log('\nFix these from the admin console: Client roster -> Reset password.');
  }
  process.exit(0);
})();
