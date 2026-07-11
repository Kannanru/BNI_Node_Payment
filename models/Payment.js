const mongoose = require('mongoose');

// Each document is a single payment transaction, not a per-month summary - a
// member can have several transactions for the same month (e.g. 2,000 via
// Cash and 3,000 via UPI for April), which is why there's no unique index on
// (memberId, month) here. Totals/remaining balance are computed by summing
// all of a month's transactions (see utils/paymentCalculator.js).
const paymentSchema = new mongoose.Schema(
  {
    memberId: { type: String, required: true, index: true },
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ }, // "YYYY-MM"
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, required: true, enum: ['upi', 'card', 'cash'] },
    cardLastFour: { type: String, match: /^\d{4}$/ }, // required when method is 'card'
    paidAt: { type: Date, required: true, default: Date.now },
    editReason: { type: String, trim: true }, // set when this transaction was later edited
    transactionRef: { type: String, trim: true }, // optional UPI/card transaction id, entered by the recorder
    remarks: { type: String, trim: true }, // optional free-text note entered by the recorder
    // Who was logged in when this transaction was created - set once at
    // creation from req.user (see authMiddleware) and never touched by
    // editPayment, so it always reflects the original recorder even if the
    // amount/method is later corrected. Payments created before this field
    // existed simply have neither set.
    recordedByName: { type: String, trim: true },
    recordedByEmail: { type: String, trim: true },
  },
  { timestamps: true }
);

paymentSchema.index({ memberId: 1, month: 1 });

module.exports = mongoose.model('Payment', paymentSchema);
