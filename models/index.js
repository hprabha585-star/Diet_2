const { sequelize } = require('../config/db');
const { DataTypes } = require('sequelize');

/* ------------------------------------------------------------------ */
/* User                                                                 */
/* ------------------------------------------------------------------ */
const User = sequelize.define('User', {
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  phone: { type: DataTypes.STRING },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.ENUM('admin', 'client'), defaultValue: 'client' },

  // Cohort / subscription
  tier: { type: DataTypes.STRING, defaultValue: 'none' },       // Plan key
  planMode: { type: DataTypes.ENUM('protocol', 'tracker'), defaultValue: 'protocol' },
  status: { type: DataTypes.ENUM('pending_payment', 'pending_approval', 'active', 'paused', 'completed', 'rejected'), defaultValue: 'pending_payment' },
  challengeStartDate: { type: DataTypes.DATEONLY },              // local calendar date, not a timestamp
  challengeLengthDays: { type: DataTypes.INTEGER, defaultValue: 55 },
  timezone: { type: DataTypes.STRING, defaultValue: 'Asia/Kolkata' },

  // Fasting pause
  pauseActive: { type: DataTypes.BOOLEAN, defaultValue: false },
  pauseReason: { type: DataTypes.STRING },
  pauseStartedAt: { type: DataTypes.DATE },
  pauseLastResumedAt: { type: DataTypes.DATE },
  pausedDays: { type: DataTypes.INTEGER, defaultValue: 0 },

  // Gamification
  points: { type: DataTypes.INTEGER, defaultValue: 0 },
  streakCurrent: { type: DataTypes.INTEGER, defaultValue: 0 },
  streakBest: { type: DataTypes.INTEGER, defaultValue: 0 },
  badges: { type: DataTypes.JSON, defaultValue: [] },

  // Referral
  referralCode: { type: DataTypes.STRING, unique: true },
  referredBy: { type: DataTypes.INTEGER },
  walletBalanceInr: { type: DataTypes.INTEGER, defaultValue: 0 },

  // Tracking / BMI
  startWeightKg: { type: DataTypes.FLOAT },
  heightCm: { type: DataTypes.FLOAT },
  age: { type: DataTypes.INTEGER },
  gender: { type: DataTypes.ENUM('female', 'male', 'other', ''), defaultValue: '' },

  // Self-guided tracker: daily water goal (only meaningful for planMode='tracker')
  waterGoalMl: { type: DataTypes.INTEGER, defaultValue: 3000 }
});

User.prototype.currentChallengeDay = function () {
  if (!this.challengeStartDate) return 0;
  // challengeStartDate is a DATEONLY (YYYY-MM-DD) — compare calendar dates only,
  // never clock time, so the day rolls over at local midnight, not at the
  // clock time the client happened to be activated.
  const start = new Date(this.challengeStartDate + 'T00:00:00');
  const today = this.pauseActive && this.pauseStartedAt
    ? new Date(this.pauseStartedAt)
    : new Date();
  const startLocal = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffDays = Math.round((todayLocal - startLocal) / 86400000);
  const day = diffDays + 1 - (this.pausedDays || 0);
  return Math.max(0, Math.min(day, this.challengeLengthDays));
};

User.prototype.bmi = function (latestWeightKg) {
  const w = latestWeightKg || this.startWeightKg;
  if (!w || !this.heightCm) return null;
  const m = this.heightCm / 100;
  return Math.round((w / (m * m)) * 10) / 10;
};

User.prototype.healthyWeightRange = function () {
  if (!this.heightCm) return null;
  const m = this.heightCm / 100;
  return {
    minKg: Math.round(18.5 * m * m * 10) / 10,
    maxKg: Math.round(24.9 * m * m * 10) / 10
  };
};

User.prototype.toSafeJSON = function () {
  const obj = this.toJSON();
  delete obj.passwordHash;
  return obj;
};

/* ------------------------------------------------------------------ */
/* WeightLog                                                            */
/* ------------------------------------------------------------------ */
const WeightLog = sequelize.define('WeightLog', {
  date: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  weightKg: { type: DataTypes.FLOAT, allowNull: false },
  note: { type: DataTypes.STRING }
});
User.hasMany(WeightLog, { foreignKey: 'userId', onDelete: 'CASCADE' });
WeightLog.belongsTo(User, { foreignKey: 'userId' });

/* ------------------------------------------------------------------ */
/* Plan (coach-editable; mode = protocol | tracker)                    */
/* ------------------------------------------------------------------ */
const Plan = sequelize.define('Plan', {
  key: { type: DataTypes.STRING, allowNull: false, unique: true },
  name: { type: DataTypes.STRING, allowNull: false },
  priceInr: { type: DataTypes.INTEGER, allowNull: false },
  durationDays: { type: DataTypes.INTEGER, defaultValue: 55 },
  tagline: { type: DataTypes.STRING },
  features: { type: DataTypes.JSON, defaultValue: [] },
  mode: { type: DataTypes.ENUM('protocol', 'tracker'), defaultValue: 'protocol' },
  active: { type: DataTypes.BOOLEAN, defaultValue: true },
  order: { type: DataTypes.INTEGER, defaultValue: 0 }
});

Plan.DEFAULTS = [
  {
    key: 'standard', name: 'Standard Tier', priceInr: 3999, durationDays: 55, order: 1, mode: 'protocol',
    tagline: 'The full 55-day coached cohort',
    features: ['Dynamic fasting engine, tuned to you', 'Coach-assigned daily meals & habits', 'Daily habit accountability checklist', 'Full cohort leaderboard access']
  },
  {
    key: 'vip', name: 'VIP / Clinical Tier', priceInr: 9999, durationDays: 55, order: 2, mode: 'protocol',
    tagline: 'Everything in Standard, plus 1-on-1 support',
    features: ['Everything in Standard', 'Dedicated 1-on-1 dietitian support', 'Cloud health report archiving', 'Partner teleconsult & pharmacy perks']
  },
  {
    key: 'tracker', name: 'Fasting Tracker', priceInr: 1999, durationDays: 30, order: 3, mode: 'tracker',
    tagline: 'Track your own fasting windows — no coach, no protocol',
    features: ['Set any fast/eat schedule you like', 'Start / stop timer with history', 'Weight & BMI tracking', 'No coach guidance — fully self-directed']
  }
];

/* ------------------------------------------------------------------ */
/* Payment / Payout                                                     */
/* ------------------------------------------------------------------ */
const Payment = sequelize.define('Payment', {
  tier: { type: DataTypes.STRING, allowNull: false },
  planName: { type: DataTypes.STRING },
  amountInr: { type: DataTypes.INTEGER, allowNull: false },
  utr: { type: DataTypes.STRING, allowNull: false },
  screenshotBase64: { type: DataTypes.TEXT('long') },
  status: { type: DataTypes.ENUM('pending', 'approved', 'rejected'), defaultValue: 'pending' },
  reviewedBy: { type: DataTypes.INTEGER },
  reviewedAt: { type: DataTypes.DATE },
  adminNote: { type: DataTypes.STRING }
});
User.hasMany(Payment, { foreignKey: 'userId', onDelete: 'CASCADE' });
Payment.belongsTo(User, { foreignKey: 'userId' });

const Payout = sequelize.define('Payout', {
  amountInr: { type: DataTypes.INTEGER, allowNull: false },
  upiId: { type: DataTypes.STRING, allowNull: false },
  status: { type: DataTypes.ENUM('pending', 'approved', 'rejected', 'paid'), defaultValue: 'pending' },
  requestedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  resolvedAt: { type: DataTypes.DATE },
  resolvedBy: { type: DataTypes.INTEGER }
});
User.hasMany(Payout, { foreignKey: 'userId', onDelete: 'CASCADE' });
Payout.belongsTo(User, { foreignKey: 'userId' });

/* ------------------------------------------------------------------ */
/* Regimen (one per client per protocol day) + meals + milestones      */
/* ------------------------------------------------------------------ */
const Regimen = sequelize.define('Regimen', {
  day: { type: DataTypes.INTEGER, allowNull: false },
  startHour: { type: DataTypes.FLOAT, allowNull: false },
  endHour: { type: DataTypes.FLOAT, allowNull: false },
  isFullDayFast: { type: DataTypes.BOOLEAN, defaultValue: false },
  protocolType: {
    type: DataTypes.ENUM('eating_window', 'refeed', 'fast_24', 'fast_36', 'fast_48', 'break_fast', 'stabilization'),
    defaultValue: 'eating_window'
  },
  phase: { type: DataTypes.STRING },
  focus: { type: DataTypes.STRING },
  waterTargetMl: { type: DataTypes.INTEGER, defaultValue: 3000 }
}, {
  indexes: [{ unique: true, fields: ['user_id', 'day'] }]
});
User.hasMany(Regimen, { foreignKey: 'userId', onDelete: 'CASCADE' });
Regimen.belongsTo(User, { foreignKey: 'userId' });

const RegimenMeal = sequelize.define('RegimenMeal', {
  type: { type: DataTypes.ENUM('morning_detox', 'breakfast', 'lunch', 'snack', 'dinner'), allowNull: false },
  name: { type: DataTypes.STRING, allowNull: false },
  calories: { type: DataTypes.INTEGER },
  proteinG: { type: DataTypes.FLOAT },
  notes: { type: DataTypes.STRING }
});
Regimen.hasMany(RegimenMeal, { foreignKey: 'regimenId', onDelete: 'CASCADE', as: 'meals' });
RegimenMeal.belongsTo(Regimen, { foreignKey: 'regimenId' });

const RegimenMilestone = sequelize.define('RegimenMilestone', {
  itemKey: { type: DataTypes.STRING, allowNull: false },
  label: { type: DataTypes.STRING, allowNull: false }
});
Regimen.hasMany(RegimenMilestone, { foreignKey: 'regimenId', onDelete: 'CASCADE', as: 'milestones' });
RegimenMilestone.belongsTo(Regimen, { foreignKey: 'regimenId' });

/* ------------------------------------------------------------------ */
/* ChecklistLog + items + water entries                                */
/*  Coach-assigned meals/habits: tick-only, drive points/streak.        */
/*  Client-added items: custom=true, editable/deletable, zero points.  */
/* ------------------------------------------------------------------ */
const ChecklistLog = sequelize.define('ChecklistLog', {
  day: { type: DataTypes.INTEGER, allowNull: false },
  date: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  waterMl: { type: DataTypes.INTEGER, defaultValue: 0 },
  completionPercent: { type: DataTypes.INTEGER, defaultValue: 0 },
  streakCounted: { type: DataTypes.BOOLEAN, defaultValue: false }
}, {
  indexes: [{ unique: true, fields: ['user_id', 'day'] }]
});
User.hasMany(ChecklistLog, { foreignKey: 'userId', onDelete: 'CASCADE' });
ChecklistLog.belongsTo(User, { foreignKey: 'userId' });

const ChecklistItem = sequelize.define('ChecklistItem', {
  itemKey: { type: DataTypes.STRING, allowNull: false },
  label: { type: DataTypes.STRING, allowNull: false },
  kind: { type: DataTypes.ENUM('meal', 'habit'), allowNull: false, defaultValue: 'habit' },
  done: { type: DataTypes.BOOLEAN, defaultValue: false },
  // true when the client added it themselves — editable/deletable, never scored
  custom: { type: DataTypes.BOOLEAN, defaultValue: false }
});
ChecklistLog.hasMany(ChecklistItem, { foreignKey: 'checklistLogId', onDelete: 'CASCADE', as: 'items' });
ChecklistItem.belongsTo(ChecklistLog, { foreignKey: 'checklistLogId' });

const WaterEntry = sequelize.define('WaterEntry', {
  ml: { type: DataTypes.INTEGER, allowNull: false },
  at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});
ChecklistLog.hasMany(WaterEntry, { foreignKey: 'checklistLogId', onDelete: 'CASCADE', as: 'waterEntries' });
WaterEntry.belongsTo(ChecklistLog, { foreignKey: 'checklistLogId' });

/* ------------------------------------------------------------------ */
/* Alerts + reads                                                        */
/* ------------------------------------------------------------------ */
const Alert = sequelize.define('Alert', {
  userId: { type: DataTypes.INTEGER, allowNull: true }, // null = whole cohort
  title: { type: DataTypes.STRING, allowNull: false },
  body: { type: DataTypes.TEXT, allowNull: false },
  level: { type: DataTypes.ENUM('info', 'important', 'urgent'), defaultValue: 'info' },
  createdBy: { type: DataTypes.INTEGER }
});

const AlertRead = sequelize.define('AlertRead', {}, { timestamps: false });
Alert.hasMany(AlertRead, { foreignKey: 'alertId', onDelete: 'CASCADE' });
AlertRead.belongsTo(Alert, { foreignKey: 'alertId' });
AlertRead.belongsTo(User, { foreignKey: 'userId' });

/* ------------------------------------------------------------------ */
/* Messages (coach <-> client chat)                                    */
/* ------------------------------------------------------------------ */
const Message = sequelize.define('Message', {
  clientId: { type: DataTypes.INTEGER, allowNull: false },
  sender: { type: DataTypes.ENUM('admin', 'client'), allowNull: false },
  body: { type: DataTypes.STRING(4000), allowNull: false },
  readByAdmin: { type: DataTypes.BOOLEAN, defaultValue: false },
  readByClient: { type: DataTypes.BOOLEAN, defaultValue: false }
});

/* ------------------------------------------------------------------ */
/* Settings (singleton "contact us")                                    */
/* ------------------------------------------------------------------ */
const Settings = sequelize.define('Settings', {
  singleton: { type: DataTypes.STRING, defaultValue: 'main', unique: true },
  coachName: { type: DataTypes.STRING, defaultValue: '' },
  phone: { type: DataTypes.STRING, defaultValue: '' },
  whatsapp: { type: DataTypes.STRING, defaultValue: '' },
  email: { type: DataTypes.STRING, defaultValue: '' },
  upiId: { type: DataTypes.STRING, defaultValue: '' },
  address: { type: DataTypes.STRING, defaultValue: '' },
  supportHours: { type: DataTypes.STRING, defaultValue: '' },
  note: { type: DataTypes.STRING, defaultValue: '' }
});
Settings.getOrCreate = async function () {
  let doc = await Settings.findOne({ where: { singleton: 'main' } });
  if (!doc) doc = await Settings.create({ singleton: 'main' });
  return doc;
};

/* ------------------------------------------------------------------ */
/* TrackerSession — Fasting Tracker plan (fully self-guided, no coach)  */
/* ------------------------------------------------------------------ */
const TrackerSession = sequelize.define('TrackerSession', {
  startAt: { type: DataTypes.DATE, allowNull: false },
  endAt: { type: DataTypes.DATE },              // null while running
  targetHours: { type: DataTypes.FLOAT, allowNull: false },
  // 'broken' is kept for rows written by the old code; new rows use
  // 'ended_early' / 'cancelled' so history can tell "stopped short" from
  // "called off without really starting".
  status: {
    type: DataTypes.ENUM('running', 'completed', 'broken', 'ended_early', 'cancelled'),
    defaultValue: 'running'
  },
  scheduleKey: { type: DataTypes.STRING, defaultValue: '16:8' },
  eatingHours: { type: DataTypes.FLOAT, defaultValue: 8 },
  // Set when the client taps "Start eating window" after finishing a fast.
  eatingStartedAt: { type: DataTypes.DATE },
  eatingEndsAt: { type: DataTypes.DATE },
  // Local calendar date the fast STARTED on, as sent by the browser. Used
  // for streaks and the calendar so a fast started at 11pm IST doesn't get
  // filed under the next UTC day.
  localDate: { type: DataTypes.DATEONLY },
  note: { type: DataTypes.STRING }
});
User.hasMany(TrackerSession, { foreignKey: 'userId', onDelete: 'CASCADE' });
TrackerSession.belongsTo(User, { foreignKey: 'userId' });

/* ------------------------------------------------------------------ */
/* TrackerProfile — one row per tracker client: their schedule, goals,  */
/* units and reminder preferences. Separate from User so the coached    */
/* side is untouched by tracker settings.                               */
/* ------------------------------------------------------------------ */
const TrackerProfile = sequelize.define('TrackerProfile', {
  scheduleKey: { type: DataTypes.STRING, defaultValue: '16:8' },
  fastHours: { type: DataTypes.FLOAT, defaultValue: 16 },
  eatHours: { type: DataTypes.FLOAT, defaultValue: 8 },
  startHour: { type: DataTypes.FLOAT, defaultValue: 20 },       // suggested daily start, 24h
  dailyGoalHours: { type: DataTypes.FLOAT, defaultValue: 16 },

  // Hydration
  waterGoalMl: { type: DataTypes.INTEGER, defaultValue: 3000 },
  waterUnit: { type: DataTypes.ENUM('ml', 'oz', 'l'), defaultValue: 'ml' },

  // Nutrition goals
  calorieGoal: { type: DataTypes.INTEGER, defaultValue: 2000 },
  proteinGoalG: { type: DataTypes.INTEGER, defaultValue: 100 },
  carbGoalG: { type: DataTypes.INTEGER, defaultValue: 250 },
  fatGoalG: { type: DataTypes.INTEGER, defaultValue: 66 },

  // Flexible weekly plan: { mon: {fastHours, eatHours, rest}, tue: {...} ... }
  weeklySchedule: { type: DataTypes.JSON, defaultValue: {} },
  schedulePaused: { type: DataTypes.BOOLEAN, defaultValue: false },

  // Reminders — in-app, fired by the browser while the app is open.
  reminders: {
    type: DataTypes.JSON,
    defaultValue: {
      water: { enabled: false, everyHours: 2, fromHour: 8, toHour: 22 },
      fastStart: { enabled: false },
      fastEndingSoon: { enabled: false, minutesBefore: 30 },
      fastCompleted: { enabled: false },
      eatingEnding: { enabled: false, minutesBefore: 30 }
    }
  },
  goalFocus: { type: DataTypes.STRING, defaultValue: 'Build a consistent fasting routine' },
  dismissedTips: { type: DataTypes.JSON, defaultValue: [] }
});
User.hasOne(TrackerProfile, { foreignKey: 'userId', onDelete: 'CASCADE' });
TrackerProfile.belongsTo(User, { foreignKey: 'userId' });

TrackerProfile.getOrCreateFor = async function (userId) {
  let profile = await TrackerProfile.findOne({ where: { userId } });
  if (!profile) profile = await TrackerProfile.create({ userId });
  return profile;
};

/* ------------------------------------------------------------------ */
/* MealEntry — nutrition log for tracker clients. Keyed by the local    */
/* calendar date the BROWSER reports, never by server time.             */
/* ------------------------------------------------------------------ */
const MealEntry = sequelize.define('MealEntry', {
  date: { type: DataTypes.DATEONLY, allowNull: false },
  category: { type: DataTypes.ENUM('breakfast', 'lunch', 'dinner', 'snack'), allowNull: false },
  name: { type: DataTypes.STRING, allowNull: false },
  quantity: { type: DataTypes.STRING },
  calories: { type: DataTypes.FLOAT, defaultValue: 0 },
  proteinG: { type: DataTypes.FLOAT, defaultValue: 0 },
  carbsG: { type: DataTypes.FLOAT, defaultValue: 0 },
  fatG: { type: DataTypes.FLOAT, defaultValue: 0 },
  notes: { type: DataTypes.STRING }
});
User.hasMany(MealEntry, { foreignKey: 'userId', onDelete: 'CASCADE' });
MealEntry.belongsTo(User, { foreignKey: 'userId' });

/* ------------------------------------------------------------------ */
/* RestDay — a day the client deliberately isn't fasting. Counted       */
/* separately from a missed day and never held against a streak.        */
/* ------------------------------------------------------------------ */
const RestDay = sequelize.define('RestDay', {
  date: { type: DataTypes.DATEONLY, allowNull: false },
  note: { type: DataTypes.STRING }
}, { indexes: [{ unique: true, fields: ['user_id', 'date'] }] });
User.hasMany(RestDay, { foreignKey: 'userId', onDelete: 'CASCADE' });
RestDay.belongsTo(User, { foreignKey: 'userId' });

/* ------------------------------------------------------------------ */
/* TrackerTaskLog — which daily task a client ticked off, per day.      */
/* ------------------------------------------------------------------ */
const TrackerTaskLog = sequelize.define('TrackerTaskLog', {
  date: { type: DataTypes.DATEONLY, allowNull: false },
  taskKey: { type: DataTypes.STRING, allowNull: false }
}, { indexes: [{ unique: true, fields: ['user_id', 'date', 'task_key'] }] });
User.hasMany(TrackerTaskLog, { foreignKey: 'userId', onDelete: 'CASCADE' });
TrackerTaskLog.belongsTo(User, { foreignKey: 'userId' });

/* ------------------------------------------------------------------ */
/* TrackerWaterEntry — water log for Fasting Tracker clients.          */
/* Keyed by calendar date, not by challenge "day", since tracker        */
/* clients have no protocol day counter at all.                        */
/* ------------------------------------------------------------------ */
const TrackerWaterEntry = sequelize.define('TrackerWaterEntry', {
  ml: { type: DataTypes.INTEGER, allowNull: false },
  at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  // The browser's local calendar date, so "today's intake" is today for
  // the client, not for whatever timezone the server happens to run in.
  localDate: { type: DataTypes.DATEONLY }
});
User.hasMany(TrackerWaterEntry, { foreignKey: 'userId', onDelete: 'CASCADE' });
TrackerWaterEntry.belongsTo(User, { foreignKey: 'userId' });

module.exports = {
  sequelize, User, WeightLog, Plan, Payment, Payout,
  Regimen, RegimenMeal, RegimenMilestone,
  ChecklistLog, ChecklistItem, WaterEntry,
  Alert, AlertRead, Message, Settings,
  TrackerSession, TrackerWaterEntry, TrackerProfile, MealEntry, RestDay, TrackerTaskLog
};
