const mongoose = require('mongoose');

const weightLogSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  weightKg: { type: Number, required: true }
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'client'], default: 'client' },

  // Cohort / subscription
  tier: { type: String, enum: ['standard', 'vip', 'none'], default: 'none' },
  status: { type: String, enum: ['pending_payment', 'active', 'paused', 'completed', 'rejected'], default: 'pending_payment' },
  challengeStartDate: { type: Date },
  challengeLengthDays: { type: Number, default: 55 },

  // Gamification
  points: { type: Number, default: 0 },
  streakCurrent: { type: Number, default: 0 },
  streakBest: { type: Number, default: 0 },
  badges: [{ type: String }],

  // Referral engine
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  walletBalanceInr: { type: Number, default: 0 },

  // Tracking
  weightLogs: [weightLogSchema],
  startWeightKg: { type: Number },
  goalWeightKg: { type: Number },

  createdAt: { type: Date, default: Date.now }
});

userSchema.methods.currentChallengeDay = function () {
  if (!this.challengeStartDate) return 0;
  const diffMs = Date.now() - new Date(this.challengeStartDate).getTime();
  const day = Math.floor(diffMs / 86400000) + 1;
  return Math.max(0, Math.min(day, this.challengeLengthDays));
};

userSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
