const mongoose = require('mongoose');

const checklistItemSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  done: { type: Boolean, default: false },
  // true when the client added the item themselves (so the UI can show it
  // as removable without touching the coach's assigned plan items)
  custom: { type: Boolean, default: false }
}, { _id: false });

// Each "+250 ml" tap is its own entry now, so it can be edited or deleted.
const waterEntrySchema = new mongoose.Schema({
  ml: { type: Number, required: true },
  at: { type: Date, default: Date.now }
});

const checklistLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  day: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  items: [checklistItemSchema],
  waterEntries: [waterEntrySchema],
  waterMl: { type: Number, default: 0 },
  completionPercent: { type: Number, default: 0 },
  streakCounted: { type: Boolean, default: false }
});

checklistLogSchema.index({ user: 1, day: 1 }, { unique: true });

// Keep waterMl in sync with the individual entries.
checklistLogSchema.methods.recalcWater = function () {
  this.waterMl = (this.waterEntries || []).reduce((sum, e) => sum + (e.ml || 0), 0);
  return this.waterMl;
};

checklistLogSchema.methods.recalcCompletion = function () {
  const done = this.items.filter(i => i.done).length;
  this.completionPercent = this.items.length ? Math.round((done / this.items.length) * 100) : 0;
  return this.completionPercent;
};

module.exports = mongoose.model('ChecklistLog', checklistLogSchema);
