const mongoose = require('mongoose');

// One-to-one chat between the coach and a client.
const messageSchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sender: { type: String, enum: ['admin', 'client'], required: true },
  body: { type: String, required: true, trim: true, maxlength: 4000 },
  readByAdmin: { type: Boolean, default: false },
  readByClient: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

messageSchema.index({ client: 1, createdAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
