const mongoose = require('mongoose');

// Coach announcements. user === null means "whole cohort".
const alertSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true, trim: true },
  level: { type: String, enum: ['info', 'important', 'urgent'], default: 'info' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

alertSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Alert', alertSchema);
