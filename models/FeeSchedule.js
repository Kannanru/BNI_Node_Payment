const mongoose = require('mongoose');
const { actorSchema } = require('./Member');

// Month-wise fee configuration. Each row says "from <effectiveMonth> onward,
// the <role> fee is <amount>" - the fee for any month M is the row with the
// latest effectiveMonth that is <= M (see utils/feeSchedule.js). Changing a
// fee ADDS a row for the month it takes effect; rows for months that have
// already started are never edited or deleted (feeController enforces this),
// so a new fee can never change what an earlier month cost.
const feeScheduleSchema = new mongoose.Schema(
  {
    role: { type: String, required: true, enum: ['member', 'visitor', 'guest'] },
    effectiveMonth: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ }, // "YYYY-MM"
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, trim: true },
    createdBy: { type: actorSchema, default: null },
    updatedBy: { type: actorSchema, default: null },
    // Previous amounts of THIS row, kept when a not-yet-started (or current)
    // month's row is changed - nothing is ever silently overwritten.
    previousAmounts: {
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

feeScheduleSchema.index({ role: 1, effectiveMonth: 1 }, { unique: true });

module.exports = mongoose.model('FeeSchedule', feeScheduleSchema);
