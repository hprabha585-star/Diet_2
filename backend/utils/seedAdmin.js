require('dotenv').config();
const bcrypt = require('bcryptjs');
const connectDB = require('../config/db');
const User = require('../models/User');

(async () => {
  await connectDB();
  const email = (process.env.ADMIN_EMAIL || 'admin@fastcoach.app').toLowerCase();
  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`Admin already exists for ${email}`);
    process.exit(0);
  }
  const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'change_this_password', 10);
  const admin = await User.create({
    name: process.env.ADMIN_NAME || 'Coach Admin',
    email,
    passwordHash,
    role: 'admin',
    status: 'active',
    tier: 'none'
  });
  console.log(`Admin account created: ${admin.email}`);
  process.exit(0);
})();
