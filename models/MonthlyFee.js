const mongoose = require('mongoose');
const { actorSchema } = require('./Member');

// The fee saved for ONE specific month and year (from Settings > Change Fee).
// It applies to that month only - saving or editing it never changes any
// other month. A month with no row here uses the general fee schedule
// (models/FeeSchedule.js). Editing keeps every earlier amount in `history`.
const monthlyFeeSchema = new mongoose.Schema(
  {
    role: { type: String, required: true, enum: ['member', 'visitor', 'guest'] },
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ }, // "YYYY-MM"
    amount: { type: Number, required: true, min: 0 },
    createdBy: { type: actorSchema, default: null },
    updatedBy: { type: actorSchema, default: null },
    history: {
      type: [
        new mongoose.Schema(
          { amount: Number, changedAt: Date, changedBy: actorSchema },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

monthlyFeeSchema.index({ role: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('MonthlyFee', monthlyFeeSchema);
