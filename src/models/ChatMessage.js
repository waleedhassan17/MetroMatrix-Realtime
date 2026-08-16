const mongoose = require('mongoose');

// OWNED by this service. If your MAIN backend already has an HSChatMessage
// collection with existing history, make sure this maps to the SAME collection
// so history is continuous. Mongoose pluralizes the model name to the collection
// ('hschatmessages'). If your real collection name differs, pass it as the 3rd
// arg: mongoose.model('HSChatMessage', schema, 'yourRealCollectionName').
const ChatMessageSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'HSBooking', index: true, required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, required: true },
    senderRole: { type: String, enum: ['user', 'provider'], required: true },
    text: { type: String, required: true },
    readBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.models.HSChatMessage || mongoose.model('HSChatMessage', ChatMessageSchema);
