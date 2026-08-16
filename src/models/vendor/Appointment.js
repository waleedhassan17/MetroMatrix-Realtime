// ============================================================================
// VENDORED VERBATIM from the MAIN MetroMatrix backend — DO NOT EDIT BY HAND.
//   source: src/modules/healthcare/models/Appointment.js
// Re-copy this file whenever the main schema changes. The realtime service
// reads these collections; it never writes to them.
// Local additions below the schema: explicit collection name + model guard.
// ============================================================================
const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Patient reference is required'],
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Doctor',
      required: [true, 'Doctor reference is required'],
    },
    slotId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Slot',
      required: [true, 'Slot reference is required'],
    },
    clinicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      default: null,
    },
    type: {
      type: String,
      enum: ['in-clinic', 'video'],
      required: [true, 'Appointment type is required'],
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'completed', 'cancelled'],
      default: 'pending',
    },
    patientInfo: {
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
      age: { type: Number, default: null },
      gender: { type: String, enum: ['male', 'female', 'other', ''], default: '' },
      relationship: { type: String, default: 'self' },
    },
    symptoms: {
      type: String,
      default: '',
    },
    fee: {
      type: Number,
      default: 0,
      min: 0,
    },
    discount: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Payment — amount frozen from the doctor's consultationFee at booking
    // time; a later fee change never alters an existing appointment.
    payment: {
      status: {
        type: String,
        enum: ['unpaid', 'paid', 'refunded'],
        default: 'unpaid',
      },
      method: {
        type: String,
        enum: ['wallet', 'cash_at_clinic', null],
        default: null,
      },
      amount: { type: Number, default: 0, min: 0 },
      walletTransactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'WalletTransaction',
        default: null,
      },
      paidAt: { type: Date, default: null },
      refundedAt: { type: Date, default: null },
      refundAmount: { type: Number, default: 0 },
    },
    // Doctor payout bookkeeping (credited at completed, minus commission)
    payout: {
      amount: { type: Number, default: 0 },
      commission: { type: Number, default: 0 },
      paidAt: { type: Date, default: null },
      walletTransactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'WalletTransaction',
        default: null,
      },
    },
    cancellationReason: {
      type: String,
      default: '',
    },
    cancelledBy: {
      type: String,
      enum: ['patient', 'doctor', 'system', ''],
      default: '',
    },
    completedAt: {
      type: Date,
      default: null,
    },
    reminderSentAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// Indexes
appointmentSchema.index({ patientId: 1, createdAt: -1 });
appointmentSchema.index({ doctorId: 1, createdAt: -1 });
appointmentSchema.index({ slotId: 1 });
appointmentSchema.index({ status: 1 });
appointmentSchema.index({ type: 1 });
appointmentSchema.index({ patientId: 1, status: 1 });
appointmentSchema.index({ doctorId: 1, status: 1 });
appointmentSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema, 'appointments');
