const mongoose = require('mongoose');

const checklistItemSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  done: { type: Boolean, default: false }
}, { _id: false });

const checklistLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  day: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  items: [checklistItemSchema],
  waterMl: { type: Number, default: 0 },
  completionPercent: { type: Number, default: 0 },
  streakCounted: { type: Boolean, default: false }
});

checklistLogSchema.index({ user: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('ChecklistLog', checklistLogSchema);
