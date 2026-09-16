const mongoose = require('mongoose');

// Coach-customisable enrollment plans (what used to be the hard-coded
// "standard" / "vip" tiers). Clients pick one of these on the Payment page.
const planSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  priceInr: { type: Number, required: true, min: 0 },
  durationDays: { type: Number, default: 55 },
  tagline: { type: String, trim: true },
  features: [{ type: String }],
  active: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

planSchema.statics.DEFAULTS = [
  {
    key: 'standard', name: 'Standard Tier', priceInr: 3999, durationDays: 55, order: 1,
    tagline: 'The full 55-day coached cohort',
    features: ['Dynamic fasting engine, tuned to you', 'Coach-assigned daily meals & macros', 'Daily habit accountability checklist', 'Full cohort leaderboard access']
  },
  {
    key: 'vip', name: 'VIP / Clinical Tier', priceInr: 9999, durationDays: 55, order: 2,
    tagline: 'Everything in Standard, plus 1-on-1 support',
    features: ['Everything in Standard', 'Dedicated 1-on-1 dietitian support', 'Cloud health report archiving', 'Partner teleconsult & pharmacy perks']
  }
];

module.exports = mongoose.model('Plan', planSchema);
