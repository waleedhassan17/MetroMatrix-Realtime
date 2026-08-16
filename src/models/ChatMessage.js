const mongoose = require('mongoose');

// ============================================================================
// SHARED with the main backend. Collection: `hschatmessages`.
//   main source: src/modules/homeservice/models/ChatMessage.js
//
// The field names below are load-bearing and MUST match main exactly. An
// earlier version of this file used bookingId / senderId / readBy against the
// same collection, which meant this service read zero existing history and
// wrote messages the main backend could not see. Do not rename these.
//
// ROOM IDS ARE POLYMORPHIC. `booking` holds either:
//   - an HSBooking _id  (roomType 'homeservice'), or
//   - an Appointment _id (roomType 'healthcare').
// The `ref: 'HSBooking'` below is inherited from main and is inert — neither
// service populates this path. ObjectIds from the two collections are disjoint,
// so a home-service thread can never surface a healthcare message.
//
// `roomType` IS INFORMATIONAL ONLY — NEVER FILTER QUERIES ON IT. Messages
// written by the main backend predate this field and have no `roomType` at all,
// so `{ roomType: 'homeservice' }` would silently hide all existing history.
// Scope reads by `{ booking: roomId }` alone.
// ============================================================================
const ChatMessageSchema = new mongoose.Schema(
  {
    // --- contract shared with main (do not rename) ---
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HSBooking',
      required: true,
      index: true,
    },
    sender: { type: mongoose.Schema.Types.ObjectId, required: true },
    // A doctor is a Provider, so 'provider' is the correct role for the doctor
    // side of a healthcare thread. Keeping this enum identical to main's means
    // main can still validate and read every row we write.
    senderRole: { type: String, enum: ['user', 'provider'], required: true },
    text: { type: String, required: true, maxlength: 2000 },
    attachments: [String],
    readAt: { type: Date, default: null },

    // --- additive, owned by this service (main ignores these: strict schema) ---
    roomType: {
      type: String,
      enum: ['homeservice', 'healthcare'],
      default: 'homeservice',
    },
    readBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },

    // Client-generated idempotency key. The app sends over the socket and falls
    // back to REST if the ack times out — without this, a slow ack stores the
    // same message twice. Sparse-unique per room (index below).
    clientMsgId: { type: String, default: undefined },
  },
  { timestamps: true }
);

// Matches main's existing index so we don't duplicate it.
ChatMessageSchema.index({ booking: 1, createdAt: 1 });
// Serves the `?before=` cursor page (sort { _id: -1 }). NOT created on boot —
// autoIndex is off so deploys never mutate collections main owns. Create it
// deliberately with: npm run ensure-indexes
ChatMessageSchema.index({ booking: 1, _id: -1 });
// Sparse so the millions of rows main wrote without a clientMsgId don't collide
// on null. Also created only via `npm run ensure-indexes`.
ChatMessageSchema.index(
  { booking: 1, clientMsgId: 1 },
  { unique: true, sparse: true }
);

module.exports =
  mongoose.models.HSChatMessage ||
  mongoose.model('HSChatMessage', ChatMessageSchema, 'hschatmessages');
