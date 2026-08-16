const mongoose = require('mongoose');

// ⚠️ REFERENCE STUB — REPLACE with your real User model copied from the main
// MetroMatrix backend for guaranteed field parity.
//
// This service only READS users (name / phone / push tokens) and updates ONLY
// `expoPushTokens` via updateOne — it never calls .save() on a user, so your
// password pre('save') hook is NEVER triggered here (that avoids re-corrupting
// credentials). strict:false lets it safely read documents that have many more
// fields than are declared below.
const UserSchema = new mongoose.Schema(
  {
    fullName: String,
    phoneNumber: String,
    profilePhoto: String,
    expoPushTokens: { type: [String], default: [] },
  },
  { timestamps: true, strict: false }
);

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
