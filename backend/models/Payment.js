const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tier: { type: String, required: true, trim: true },   // Plan key
  planName: { type: String, trim: true },
  amountInr: { type: Number, required: true },
  utr: { type: String, required: true, trim: true },
  screenshotBase64: { type: String }, // small data-url image, kept optional
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  adminNote: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Payment', paymentSchema);
