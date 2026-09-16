const mongoose = require('mongoose');

// NOTE: weight logs now carry their own _id so a client can edit/delete
// a single entry from the History & weight page.
const weightLogSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  weightKg: { type: Number, required: true },
  note: { type: String, trim: true }
});

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'client'], default: 'client' },

  // Cohort / subscription
  // tier is now a Plan key (plans are coach-editable), 'none' until chosen
  tier: { type: String, default: 'none', trim: true },
  status: { type: String, enum: ['pending_payment', 'active', 'paused', 'completed', 'rejected'], default: 'pending_payment' },
  challengeStartDate: { type: Date },
  challengeLengthDays: { type: Number, default: 55 },

  // Fasting pause (illness, travel, medical advice, etc.)
  fastingPause: {
    active: { type: Boolean, default: false },
    reason: { type: String, trim: true },
    startedAt: { type: Date },
    lastResumedAt: { type: Date }
  },
  // Total whole days the challenge clock has been frozen. Subtracted from the
  // current challenge day so a paused client doesn't "lose" days of plan.
  pausedDays: { type: Number, default: 0 },

  // Gamification
  points: { type: Number, default: 0 },
  streakCurrent: { type: Number, default: 0 },
  streakBest: { type: Number, default: 0 },
  badges: [{ type: String }],

  // Referral engine
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  walletBalanceInr: { type: Number, default: 0 },

  // Tracking / BMI
  weightLogs: [weightLogSchema],
  startWeightKg: { type: Number },
  goalWeightKg: { type: Number },   // legacy, no longer used by the BMI tool
  heightCm: { type: Number },
  age: { type: Number, min: 2, max: 120 },
  gender: { type: String, enum: ['female', 'male', 'other', ''], default: '' },

  createdAt: { type: Date, default: Date.now }
});

userSchema.methods.currentChallengeDay = function () {
  if (!this.challengeStartDate) return 0;
  const paused = this.fastingPause && this.fastingPause.active && this.fastingPause.startedAt;
  // While paused the clock is frozen at the moment the pause began.
  const reference = paused ? new Date(this.fastingPause.startedAt).getTime() : Date.now();
  const diffMs = reference - new Date(this.challengeStartDate).getTime();
  const day = Math.floor(diffMs / 86400000) + 1 - (this.pausedDays || 0);
  return Math.max(0, Math.min(day, this.challengeLengthDays));
};

userSchema.methods.bmi = function () {
  const latest = this.weightLogs && this.weightLogs.length
    ? this.weightLogs[this.weightLogs.length - 1].weightKg
    : this.startWeightKg;
  if (!latest || !this.heightCm) return null;
  const m = this.heightCm / 100;
  return Math.round((latest / (m * m)) * 10) / 10;
};

// Healthy weight band for this person's height (BMI 18.5–24.9).
userSchema.methods.healthyWeightRange = function () {
  if (!this.heightCm) return null;
  const m = this.heightCm / 100;
  return {
    minKg: Math.round(18.5 * m * m * 10) / 10,
    maxKg: Math.round(24.9 * m * m * 10) / 10
  };
};

userSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  obj.bmi = this.bmi();
  obj.healthyWeightRange = this.healthyWeightRange();
  return obj;
};

module.exports = mongoose.model('User', userSchema);
