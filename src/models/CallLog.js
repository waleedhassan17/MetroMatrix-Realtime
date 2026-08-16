const mongoose = require('mongoose');

// ============================================================================
// OWNED ENTIRELY by this service. Collection: `calllogs`.
// The main backend has no CallLog model (one exists only on the unmerged,
// stale origin/Chat-and-Call branch — an abandoned Agora design. Do not merge
// its chat/call files; its schema would write mutually-invalid documents into
// this same collection).
//
// THE CALL ID IS THE DOCUMENT _id. There is deliberately no separate `callId`
// field — a second identifier that has to be kept in sync with _id is pure
// downside. The id is minted in-process before the insert, so it can go out on
// the wire with zero added ring latency, and every later transition is a
// primary-key update.
//
// This replaces the previous pattern:
//     findOneAndUpdate({ roomId, status: 'ring' }, …, { sort: { createdAt: -1 } })
// which, whenever two calls overlapped on one room, updated whichever row
// happened to be newest — i.e. the wrong call.
// ============================================================================
const CallLogSchema = new mongoose.Schema(
  {
    // Polymorphic room id — HSBooking _id or Appointment _id. See ChatMessage.js.
    roomId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    roomType: {
      type: String,
      enum: ['homeservice', 'healthcare'],
      required: true,
    },

    from: { type: mongoose.Schema.Types.ObjectId, required: true },
    to: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Role of the CALLER, derived from booking/appointment membership in the
    // database — never from the JWT. See src/utils/access.js.
    fromRole: { type: String, enum: ['user', 'provider'], required: true },

    // [from, to]. One indexed predicate answers "is either party on a call?",
    // which is what the busy check needs — a user can be occupied as the
    // caller just as easily as the callee.
    participants: {
      type: [mongoose.Schema.Types.ObjectId],
      required: true,
      index: true,
    },

    status: {
      type: String,
      // ring     → dialing, callee notified
      // accepted → callee picked up (native dialer handoff happens client-side)
      // declined → callee actively rejected
      // missed   → ring timed out with no answer
      // busy     → callee was already on another in-app call
      // ended    → normal hang-up after accept
      enum: ['ring', 'accepted', 'declined', 'missed', 'busy', 'ended'],
      default: 'ring',
      index: true,
    },
    endReason: {
      type: String,
      enum: ['hangup', 'timeout', 'peer_disconnect', 'server_restart', 'stale', 'busy', null],
      default: null,
    },

    startedAt: { type: Date, default: Date.now },
    answeredAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    durationSec: { type: Number, default: null },
  },
  { timestamps: true }
);

// Busy check: "does either party have an open call?"
CallLogSchema.index({ participants: 1, status: 1, startedAt: -1 });
// Per-room call history.
CallLogSchema.index({ roomId: 1, startedAt: -1 });
// Stale-row sweeper.
CallLogSchema.index({ status: 1, startedAt: -1 });

module.exports =
  mongoose.models.CallLog || mongoose.model('CallLog', CallLogSchema, 'calllogs');
