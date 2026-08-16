const mongoose = require('mongoose');

// ============================================================================
// READ-ONLY PROJECTION of the main backend's User model.
//   main source: src/models/User.js  (collection: users)
//
// Deliberately NOT a verbatim copy. The real User schema carries bcrypt
// password-hashing `pre('save')` hooks and credential helper methods; loading
// those into this service would add a bcrypt dependency and leave a live
// save-hook in a process that must never write to the users collection.
//
// This service only ever:
//   - READS  fullName / phoneNumber / profilePhoto (for chat participants and
//            the call screen's native-dialer handoff)
//   - WRITES expoPushTokens, and only via updateOne + $addToSet / $pull.
// It never calls .save() on a user.
//
// `strict: false` means documents keep every field the main backend stores, so
// reads are lossless even though only the contract below is declared. The
// declared names are the drift-sensitive ones and are asserted at boot by
// src/utils/verifySchema.js.
// ============================================================================
const UserSchema = new mongoose.Schema(
  {
    fullName: String,
    phoneNumber: String,
    profilePhoto: String,
    email: String,
    isActive: { type: Boolean, default: true },

    // Owned by THIS service — the main backend has no push infrastructure and
    // does not declare this path. Written with $addToSet so re-registering the
    // same device is idempotent.
    expoPushTokens: { type: [String], default: [] },
  },
  { timestamps: true, strict: false }
);

module.exports = mongoose.models.User || mongoose.model('User', UserSchema, 'users');
