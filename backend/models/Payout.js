const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amountInr: { type: Number, required: true },
  upiId: { type: String, required: true, trim: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'paid'], default: 'pending' },
  requestedAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

module.exports = mongoose.model('Payout', payoutSchema);
