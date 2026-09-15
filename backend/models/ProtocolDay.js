const mongoose = require('mongoose');

// The coach-editable master 55-day protocol. One document per day.
// Seeded from utils/protocolData.js via `npm run seed:protocol`.
const protocolDaySchema = new mongoose.Schema({
  day: { type: Number, required: true, unique: true, min: 1 },
  phase: { type: String, required: true },
  protocolType: {
    type: String,
    enum: ['eating_window', 'refeed', 'fast_24', 'fast_36', 'fast_48', 'break_fast', 'stabilization'],
    default: 'eating_window'
  },
  label: { type: String },                 // e.g. "16/8 stability day"
  startHour: { type: Number },             // eating window start (null on full fasts)
  endHour: { type: Number },               // eating window end
  isFullDayFast: { type: Boolean, default: false },
  eatingHours: { type: Number },
  fastingHours: { type: Number },
  focus: { type: String },                 // coach/client guidance for the day
  waterTargetMl: { type: Number, default: 3000 },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ProtocolDay', protocolDaySchema);
