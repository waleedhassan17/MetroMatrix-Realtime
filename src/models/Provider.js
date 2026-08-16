const mongoose = require('mongoose');

// ⚠️ REFERENCE STUB — REPLACE with your real Provider model copied from the
// main MetroMatrix backend. Read-only here except for `expoPushTokens`
// (updated via updateOne, never .save()). strict:false so extra fields on the
// real documents are preserved on read.
const ProviderSchema = new mongoose.Schema(
  {
    fullName: String,
    phoneNumber: String,
    profilePhoto: String,
    expoPushTokens: { type: [String], default: [] },
  },
  { timestamps: true, strict: false }
);

module.exports = mongoose.models.Provider || mongoose.model('Provider', ProviderSchema);
