const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { generateReferralCode } = require('../utils/helpers');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function signToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// POST /api/auth/register  (client signup — status starts pending_payment)
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, referralCode } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findOne({ referralCode: referralCode.toUpperCase().trim() });
      if (referrer) referredBy = referrer._id;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let code;
    do {
      code = generateReferralCode(name);
    } while (await User.findOne({ referralCode: code }));

    const user = await User.create({
      name, email: email.toLowerCase(), phone, passwordHash,
      role: 'client', referralCode: code, referredBy
    });

    const token = signToken(user);
    res.status(201).json({ token, user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed', detail: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken(user);
    res.json({ token, user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Login failed', detail: err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

module.exports = router;
