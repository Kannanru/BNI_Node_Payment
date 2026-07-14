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

// One amount this visitor was billed, the date it became due, and its own
// independent payment history. A visitor gets exactly one charge, fixed at
// whatever Settings.visitorFee was at the moment THEY were created (see
// visitorController.js's createVisitor) - later changes to
// Settings.visitorFee only affect visitors created after that point, never
// this one. Structured as an array (rather than a single amount on the
// visitor itself) so a future charge type isn't precluded, and so payments
// stay scoped to the specific charge they paid off. Keeps its default _id
// so the API/UI can address a specific charge to pay.
const visitorChargeSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    effectiveFrom: { type: Date, required: true, default: Date.now },
    payments: { type: [visitorPaymentSchema], default: [] },
  }
);

const visitorSchema = new mongoose.Schema(
  {
    memberId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    // Optional by design - createVisitor no longer requires a valid email/
    // phone to add a visitor, only a name.
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    // Every payment now lives under the specific charge it paid off (see
    // visitorChargeSchema above) - there is deliberately no flat top-level
    // payments array any more, so a payment can never be ambiguous about
    // which due record it belongs to.
    charges: { type: [visitorChargeSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Visitor', visitorSchema);
