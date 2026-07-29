const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    // Singleton document identifier
    key: { type: String, required: true, unique: true, default: 'app_settings' },
    // Kept in sync with memberPaymentStartDate (see settingsController.js) -
    // still the field every month-range calculation actually reads, since
    // only the year/month of that date matters for that purpose.
    defaultStartMonth: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ }, // "YYYY-MM"
    // Anchor for the Home screen's visible month COLUMNS only - independent
    // of defaultStartMonth, which anchors the Total Pending balance (the
    // club's true amount owed can predate when this column ever started
    // being shown). Set once, to whichever month this rolling-column feature
    // was turned on in a given environment (see getSettings.js's DEFAULTS
    // and backfill) - from then on the column window grows by one month
    // every 1st with no further changes needed. See
    // paymentCalculator.js#buildMemberList.
    columnDisplayStartMonth: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    monthlyFee: { type: Number, required: true, min: 0 },
    visitorFee: { type: Number, required: true, min: 0 },
    // Every value visitorFee has ever been set to, each with the date it
    // became effective - visitorFee itself always holds the latest entry's
    // amount (every existing read of visitorFee, e.g. buildVisitorStatus,
    // is unaffected), this is purely an audit trail so the Settings screen
    // can show "which amount applies as of which date". Deliberately
    // visitor-only - monthlyFee (Members) has no equivalent history.
    visitorFeeHistory: {
      type: [
        {
          _id: false,
          amount: { type: Number, required: true, min: 0 },
          effectiveFrom: { type: Date, required: true },
        },
      ],
      default: [],
    },
    // Guests mirror Visitors exactly (see models/Visitor.js's `type` field) -
    // a separate fee amount because a guest's fee is set independently of a
    // visitor's, but the same "snapshotted at creation, never retroactive"
    // semantics apply (see visitorController.js's createVisitor).
    guestFee: { type: Number, required: true, min: 0 },
    guestFeeHistory: {
      type: [
        {
          _id: false,
          amount: { type: Number, required: true, min: 0 },
          effectiveFrom: { type: Date, required: true },
        },
      ],
      default: [],
    },
    // The full date (day precision) members' payment tracking starts from -
    // the source of truth defaultStartMonth is derived from.
    memberPaymentStartDate: { type: Date, required: true },
    // Visitors added before this date are excluded from every pending/owed
    // calculation app-wide (see paymentCalculator.js's isVisitorInScope) -
    // i.e. visitors added before the org started tracking visitor fees are
    // grandfathered in rather than retroactively owing anything. No longer
    // editable from the Settings screen (Visitor config has no Starting
    // Month field), but still stored/enforced - it keeps whatever value it
    // already has unless a future internal process changes it.
    visitorPaymentStartDate: { type: Date, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
