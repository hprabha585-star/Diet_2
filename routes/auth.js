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

// POST /api/auth/create-first-admin
// One-shot bootstrap: creates the very first admin account, only if no
// admin exists yet. Once any admin exists, this route permanently refuses.
// This is what the login page's "First time? Create admin account" link calls.
router.post('/create-first-admin', async (req, res) => {
  try {
    const existingAdmin = await User.findOne({ where: { role: 'admin' } });
    if (existingAdmin) {
      return res.status(403).json({ error: 'An admin already exists. This endpoint is disabled.' });
    }

    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const admin = await User.create({
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: 'admin',
      status: 'active',
      tier: 'none'
    });

    res.status(201).json({ user: admin.toSafeJSON() });
  } catch (err) {
    console.error('create-first-admin failed:', err);
    res.status(500).json({ error: 'Could not create admin', detail: err.message });
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

    if (user.role === 'admin' && user.status === 'pending_approval') {
      return res.status(403).json({ error: 'Your coach/admin account is pending approval. It has not been activated yet.' });
    }

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

// POST /api/auth/request-admin — creates a coach/admin account with a
// properly bcrypt-hashed password, but leaves it in status='pending_approval'.
// Kept as a fallback; the primary path is /create-first-admin above.
router.post('/request-admin', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await User.findOne({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const admin = await User.create({
      name, email: email.toLowerCase(), passwordHash, role: 'admin', status: 'pending_approval', tier: 'none'
    });
    res.status(201).json({ requested: true, email: admin.email });
  } catch (err) {
    console.error('request-admin failed:', err);
    res.status(500).json({ error: 'Could not submit request', detail: err.message });
  }
});

module.exports = router;