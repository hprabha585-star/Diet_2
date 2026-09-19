const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { generateReferralCode } = require('../utils/helpers');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// POST /api/auth/register  (client signup — status starts pending_payment)
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, referralCode } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    const existing = await User.findOne({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findOne({ where: { referralCode: referralCode.toUpperCase().trim() } });
      if (referrer) referredBy = referrer.id;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let code;
    do {
      code = generateReferralCode(name);
    } while (await User.findOne({ where: { referralCode: code } }));

    const user = await User.create({
      name, email: email.toLowerCase(), phone, passwordHash,
      role: 'client', referralCode: code, referredBy
    });

    const token = signToken(user);
    res.status(201).json({ token, user: user.toSafeJSON() });
  } catch (err) {
    console.error('Registration failed:', err);
    res.status(500).json({ error: 'Registration failed', detail: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ where: { email: email.toLowerCase() } });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken(user);
    res.json({ token, user: user.toSafeJSON() });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Login failed', detail: err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

// GET /api/auth/admin-exists — lets the login page know whether the
// "Create admin account" link should still be offered.
router.get('/admin-exists', async (req, res) => {
  try {
    const count = await User.count({ where: { role: 'admin' } });
    res.json({ exists: count > 0 });
  } catch (err) {
    console.error('admin-exists check failed:', err);
    res.status(500).json({ error: 'Could not check admin status', detail: err.message });
  }
});

// POST /api/auth/bootstrap-admin — creates the FIRST coach/admin account
// straight from the browser, no SSH or seed script needed. This only ever
// works once: as soon as any admin exists, it refuses. If ADMIN_SETUP_KEY
// is set in the environment, it also requires that key — leave it unset
// to skip that check.
router.post('/bootstrap-admin', async (req, res) => {
  try {
    const existingAdminCount = await User.count({ where: { role: 'admin' } });
    if (existingAdminCount > 0) {
      return res.status(409).json({ error: 'An admin account already exists. Sign in normally, or ask an existing admin to create more coach accounts.' });
    }
    if (process.env.ADMIN_SETUP_KEY && req.body.setupKey !== process.env.ADMIN_SETUP_KEY) {
      return res.status(403).json({ error: 'Incorrect setup key.' });
    }
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const passwordHash = await bcrypt.hash(password, 10);
    const admin = await User.create({
      name, email: email.toLowerCase(), passwordHash, role: 'admin', status: 'active', tier: 'none'
    });
    const token = signToken(admin);
    res.status(201).json({ token, user: admin.toSafeJSON() });
  } catch (err) {
    console.error('bootstrap-admin failed:', err);
    res.status(500).json({ error: 'Could not create admin account', detail: err.message });
  }
});

module.exports = router;
