const mongoose = require('mongoose');

// ⚠️ REFERENCE STUB — REPLACE with your real home-service booking model from
// the main backend, OR make sure the field names below match it. This service
// only READS bookings, to verify who is allowed in a chat/call room and to
// look up participant details. It NEVER writes bookings.
//
// The two fields that matter: `customer` (the user) and `provider`. If your
// real schema names them differently, update BOTH this file and
// src/utils/access.js to match.
const BookingSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    provider: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' },
    status: String,
  },
  { timestamps: true, strict: false }
);

// Map to your real bookings collection name if it isn't 'hsbookings'.
module.exports = mongoose.models.HSBooking || mongoose.model('HSBooking', BookingSchema);
