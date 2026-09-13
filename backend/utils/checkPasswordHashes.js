// One-off diagnostic: finds any user whose passwordHash is NOT a valid
// bcrypt hash. This happens when an account is inserted directly into
// MongoDB (e.g. via the Atlas UI) with a plain-text password instead of
// going through /api/auth/register or the admin "create client" form —
// bcrypt.compare() will never match a plain-text string, so that account
// can never log in until its password is reset.
//
// Run with:  node utils/checkPasswordHashes.js
require('dotenv').config();
const connectDB = require('../config/db');
const User = require('../models/User');

const BCRYPT_PATTERN = /^\$2[aby]\$\d{2}\$/;

(async () => {
  await connectDB();
  const users = await User.find({}).select('name email passwordHash role');
  const broken = users.filter(u => !BCRYPT_PATTERN.test(u.passwordHash || ''));

  if (broken.length === 0) {
    console.log(`Checked ${users.length} users — all passwords are properly hashed.`);
  } else {
    console.log(`Checked ${users.length} users — ${broken.length} have an invalid (non-bcrypt) password and CANNOT log in:`);
    broken.forEach(u => console.log(`  - ${u.name} <${u.email}> (${u.role}) — id: ${u._id}`));
    console.log('\nFix these from the admin console: Client roster -> Reset password.');
  }
  process.exit(0);
})();
