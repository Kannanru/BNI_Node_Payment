const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    // Singleton document identifier
    key: { type: String, required: true, unique: true, default: 'app_settings' },
    // Kept in sync with memberPaymentStartDate (see settingsController.js) -
    // still the field every month-range calculation actually reads, since
    // only the year/month of that date matters for that purpose.
    defaultStartMonth: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ }, // "YYYY-MM"
    monthlyFee: { type: Number, required: true, min: 0 },
    visitorFee: { type: Number, required: true, min: 0 },
    // The full date (day precision) members' payment tracking starts from -
    // the source of truth defaultStartMonth is derived from.
    memberPaymentStartDate: { type: Date, required: true },
    // Visitors added before this date are excluded from every pending/owed
    // calculation app-wide (see paymentCalculator.js's isVisitorInScope) -
    // i.e. visitors added before the org started tracking visitor fees are
    // grandfathered in rather than retroactively owing anything.
    visitorPaymentStartDate: { type: Date, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
