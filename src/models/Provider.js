const mongoose = require('mongoose');

// ============================================================================
// READ-ONLY PROJECTION of the main backend's Provider model.
//   main source: src/models/Provider.js  (collection: providers)
//
// Same rationale as src/models/User.js — the real schema carries bcrypt
// password hooks that must not be loaded into a service that never writes to
// the providers collection. See that file for the full explanation.
//
// IMPORTANT — a doctor IS a Provider:
//   Provider.providerType === 'doctor', and the JWT minted by the main backend
//   carries the *Provider* _id, never the Doctor _id. The Doctor profile row
//   (collection `doctors`) links back via Doctor.providerId. Phone numbers and
//   push tokens for a doctor therefore live HERE, on the Provider document —
//   the Doctor schema has no phone field at all.
// ============================================================================
const ProviderSchema = new mongoose.Schema(
  {
    fullName: String,
    phoneNumber: String,
    profilePhoto: String,
    email: String,
    businessName: String,
    // 'doctor' | 'home_service' | 'vendor' | 'pending'
    providerType: String,
    isActive: { type: Boolean, default: true },
    isOnline: { type: Boolean, default: false },

    // Owned by THIS service — see User.js.
    expoPushTokens: { type: [String], default: [] },
  },
  { timestamps: true, strict: false }
);

module.exports =
  mongoose.models.Provider || mongoose.model('Provider', ProviderSchema, 'providers');
