// ============================================================================
// VENDORED VERBATIM from the MAIN MetroMatrix backend — DO NOT EDIT BY HAND.
//   source: src/modules/homeservice/models/Booking.js
// Re-copy this file whenever the main schema changes. The realtime service
// reads these collections; it never writes to them.
// Local additions below the schema: explicit collection name + model guard.
// ============================================================================
const mongoose = require('mongoose');
const { ALL_STATUSES, STATUS } = require('./statusMap');

const bookingSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Provider',
      required: true,
      index: true,
    },
    serviceCategory: {
      type: String, // 'electricians' | 'plumbers' | 'ac-repairers' (frontend vocab)
      required: true,
    },
    serviceSubCategory: String,
    description: {
      type: String,
      maxlength: 2000,
      default: '',
    },
    images: [String],
    scheduledFor: {
      type: Date,
      required: true,
    },
    scheduledTime: String, // display slot label the customer picked, e.g. "02:00 PM"
    address: {
      label: String,
      line1: { type: String, required: true },
      city: String,
      icon: { type: String, default: 'location' },
      coordinates: {
        type: {
          type: String,
          enum: ['Point'],
          default: 'Point',
        },
        coordinates: {
          type: [Number], // [lng, lat]
          default: [0, 0],
        },
      },
    },
    status: {
      type: String,
      enum: ALL_STATUSES,
      default: STATUS.PENDING,
      index: true,
    },
    // Append-only trail — every transition (including admin forces) lands here
    statusHistory: [
      {
        status: { type: String, enum: ALL_STATUSES, required: true },
        changedBy: {
          id: { type: mongoose.Schema.Types.ObjectId },
          role: { type: String, enum: ['customer', 'provider', 'admin', 'system'] },
        },
        changedAt: { type: Date, default: Date.now },
        note: String,
      },
    ],
    pricing: {
      estimatedPrice: { type: Number, default: 0 },
      finalPrice: { type: Number, default: null },
      currency: { type: String, default: 'PKR' },
    },
    payment: {
      status: {
        type: String,
        enum: ['unpaid', 'requested', 'paid'],
        default: 'unpaid',
      },
      method: { type: String, enum: ['wallet', 'cash', 'jazzcash', 'easypaisa', null], default: null },
      walletTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },
      requestedAmount: { type: Number, default: null },
      paidAt: Date,
    },
    cancellation: {
      by: { type: String, enum: ['customer', 'provider', 'admin', null], default: null },
      reason: String,
      at: Date,
    },
    instructions: { type: String, default: '' },
    // Work timing (start-work / complete-work on the provider side)
    work: {
      startedAt: Date,
      endedAt: Date,
      actualDurationMinutes: { type: Number, default: null },
      notes: String,
      photos: [String],
    },
  },
  { timestamps: true }
);

bookingSchema.index({ 'address.coordinates': '2dsphere' });
bookingSchema.index({ customer: 1, status: 1, createdAt: -1 });
bookingSchema.index({ provider: 1, status: 1, scheduledFor: 1 });

module.exports =
  mongoose.models.HSBooking || mongoose.model('HSBooking', bookingSchema, 'hsbookings');
