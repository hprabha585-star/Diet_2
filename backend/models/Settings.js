const mongoose = require('mongoose');

// Single settings document — the "Contact us" details the coach fills in,
// shown to every client on their dashboard.
const settingsSchema = new mongoose.Schema({
  singleton: { type: String, default: 'main', unique: true },
  coachName: { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  whatsapp: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, default: '' },
  upiId: { type: String, trim: true, default: '' },
  address: { type: String, trim: true, default: '' },
  supportHours: { type: String, trim: true, default: '' },
  note: { type: String, trim: true, default: '' },
  updatedAt: { type: Date, default: Date.now }
});

settingsSchema.statics.getOrCreate = async function () {
  let doc = await this.findOne({ singleton: 'main' });
  if (!doc) doc = await this.create({ singleton: 'main' });
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
