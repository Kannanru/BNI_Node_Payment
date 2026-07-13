const mongoose = require('mongoose');

// One visitor-fee payment transaction, same shape as a Payment document -
// a visitor's fee can be paid across several methods (e.g. 2,000 Cash and
// 3,000 UPI), so this is an array rather than a single amount/method pair.
const visitorPaymentSchema = new mongoose.Schema(
  {
    method: { type: String, required: true, enum: ['upi', 'card', 'cash'] },
    amount: { type: Number, required: true, min: 0 },
    cardLastFour: { type: String, match: /^\d{4}$/ }, // required when method is 'card'
    paidAt: { type: Date, required: true, default: Date.now },
    editReason: { type: String, trim: true }, // set when this transaction was later edited
    transactionRef: { type: String, trim: true }, // optional UPI/card transaction id, entered by the recorder
    remarks: { type: String, trim: true }, // optional free-text note entered by the recorder
    recordedByName: { type: String, trim: true }, // who was logged in when this transaction was created
    recordedByEmail: { type: String, trim: true },
  },
  { timestamps: true }
);

// The visitor fee itself is never stored here - it's always read live from
// Settings.visitorFee (see utils/paymentCalculator.js buildVisitorStatus), so
// raising/lowering the fee immediately applies to every outstanding visitor
// charge instead of freezing at whatever the fee was when the visitor was
// added.
const visitorSchema = new mongoose.Schema(
  {
    memberId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    // Optional by design - createVisitor no longer requires a valid email/
    // phone to add a visitor, only a name.
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    payments: { type: [visitorPaymentSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Visitor', visitorSchema);
