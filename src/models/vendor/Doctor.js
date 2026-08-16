// ============================================================================
// VENDORED VERBATIM from the MAIN MetroMatrix backend — DO NOT EDIT BY HAND.
//   source: src/modules/healthcare/models/Doctor.js
// Re-copy this file whenever the main schema changes. The realtime service
// reads these collections; it never writes to them.
// Local additions below the schema: explicit collection name + model guard.
// ============================================================================
const mongoose = require('mongoose');

const doctorSchema = new mongoose.Schema(
  {
    // A doctor is a Provider (providerType: 'doctor'). Identity links to Provider.
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Provider',
      required: [true, 'Provider reference is required'],
    },
    specialtyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Specialty',
      default: null,
    },
    pmcNumber: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    qualifications: {
      type: [String],
      default: [],
    },
    experience: {
      type: Number,
      default: 0,
      min: 0,
    },
    about: {
      type: String,
      default: '',
    },
    consultationFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    videoConsultationFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    totalReviews: {
      type: Number,
      default: 0,
    },
    verificationStatus: {
      type: String,
      // 'verified' is the patient-visible / approved state.
      enum: ['pending', 'under_review', 'verified', 'rejected'],
      default: 'pending',
    },
    verificationNotes: {
      type: String,
      default: '',
    },
    verificationDocuments: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Availability toggle (doctor temporarily unavailable)
    isAvailable: {
      type: Boolean,
      default: true,
    },
    unavailableFrom: {
      type: Date,
      default: null,
    },
    unavailableTo: {
      type: Date,
      default: null,
    },
    // Weekly recurring availability. Per day, the doctor can be available online
    // (video) and/or onsite (in-clinic), each with its own time ranges.
    weeklyAvailability: {
      type: [
        {
          _id: false,
          day: {
            type: String,
            enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
          },
          isWorking: { type: Boolean, default: false },
          online: {
            enabled: { type: Boolean, default: false },
            ranges: {
              type: [{ _id: false, startTime: String, endTime: String }],
              default: [],
            },
          },
          onsite: {
            enabled: { type: Boolean, default: false },
            clinicId: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
            ranges: {
              type: [{ _id: false, startTime: String, endTime: String }],
              default: [],
            },
          },
        },
      ],
      default: [],
    },
    // Specific dates the doctor is absent (overrides weeklyAvailability).
    absentDates: {
      type: [Date],
      default: [],
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

// Virtuals
doctorSchema.virtual('clinics', {
  ref: 'Clinic',
  localField: '_id',
  foreignField: 'doctorId',
});

doctorSchema.virtual('slots', {
  ref: 'Slot',
  localField: '_id',
  foreignField: 'doctorId',
});

// Indexes
doctorSchema.index({ providerId: 1 }, { unique: true });
doctorSchema.index({ specialtyId: 1 });
doctorSchema.index({ verificationStatus: 1 });
doctorSchema.index({ isActive: 1 });
doctorSchema.index({ rating: -1 });
doctorSchema.index({ consultationFee: 1 });

module.exports =
  mongoose.models.Doctor || mongoose.model('Doctor', doctorSchema, 'doctors');
