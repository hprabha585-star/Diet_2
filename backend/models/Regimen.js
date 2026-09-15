const mongoose = require('mongoose');

// One regimen document = one client's plan for one challenge day.
const mealSchema = new mongoose.Schema({
  type: { type: String, enum: ['morning_detox', 'breakfast', 'lunch', 'snack', 'dinner'], required: true },
  name: { type: String, required: true },
  calories: { type: Number },
  proteinG: { type: Number },
  notes: { type: String }
}, { _id: false });

const milestoneSchema = new mongoose.Schema({
  key: { type: String, required: true },      // e.g. "protein_target", "workout"
  label: { type: String, required: true }      // e.g. "Hit 80g protein"
}, { _id: false });

const regimenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  day: { type: Number, required: true },
  fastingWindow: {
    startHour: { type: Number, required: true }, // eating window start, 0-23.99
    endHour: { type: Number, required: true }    // eating window end, 0-23.99
  },
  // Set for 24h / 36h / 48h protocol days — there is no eating window at all.
  isFullDayFast: { type: Boolean, default: false },
  protocolType: {
    type: String,
    enum: ['eating_window', 'refeed', 'fast_24', 'fast_36', 'fast_48', 'break_fast', 'stabilization'],
    default: 'eating_window'
  },
  phase: { type: String },
  focus: { type: String },
  meals: [mealSchema],
  milestones: [milestoneSchema],
  waterTargetMl: { type: Number, default: 3000 },
  createdAt: { type: Date, default: Date.now }
});

regimenSchema.index({ user: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('Regimen', regimenSchema);
