const mongoose = require('mongoose');

// OWNED by this service. This is your accountability record: every ring,
// accept, decline, miss and end is written here, in the SHARED database, so
// both backends (and an admin panel) can see call history.
const CallLogSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'HSBooking', index: true, required: true },
    from: { type: mongoose.Schema.Types.ObjectId, required: true },
    to: { type: mongoose.Schema.Types.ObjectId },
    fromRole: { type: String, enum: ['user', 'provider'] },
    status: { type: String, enum: ['ring', 'accepted', 'declined', 'missed', 'ended'], default: 'ring' },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.models.CallLog || mongoose.model('CallLog', CallLogSchema);
