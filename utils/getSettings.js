const Settings = require('../models/Settings');
const { monthKeyOf } = require('./monthRange');

// These are pure calendar dates (no time-of-day meaning), so they're always
// constructed as UTC midnight via Date.UTC - constructing with `new
// Date(year, month, day)` instead would use the server's local timezone,
// which then shifts to the previous/next day once serialized back out via
// toISOString() (see settingsController.js's serialize()) unless the server
// happens to run in UTC.
// columnDisplayStartMonth defaults to the current month (not Jan like
// defaultStartMonth) - a brand new environment (e.g. a freshly deployed
// production instance) should start its rolling column window from whenever
// it first came online, not from some arbitrary historical month.
const DEFAULTS = {
  key: 'app_settings',
  defaultStartMonth: `${new Date().getFullYear()}-01`,
  columnDisplayStartMonth: monthKeyOf(new Date().getFullYear(), new Date().getMonth() + 1),
  monthlyFee: 100,
  visitorFee: 50,
  guestFee: 50,
  memberPaymentStartDate: new Date(Date.UTC(new Date().getFullYear(), 0, 1)),
  visitorPaymentStartDate: new Date(Date.UTC(new Date().getFullYear(), 0, 1)),
};

// Settings is a singleton document; create it with sane defaults on first read.
async function getOrCreateSettings() {
  let settings = await Settings.findOne({ key: 'app_settings' });
  if (!settings) {
    settings = await Settings.create({
      ...DEFAULTS,
      visitorFeeHistory: [{ amount: DEFAULTS.visitorFee, effectiveFrom: new Date() }],
      guestFeeHistory: [{ amount: DEFAULTS.guestFee, effectiveFrom: new Date() }],
    });
    return settings;
  }

  // Backfill for a Settings document that predates memberPaymentStartDate/
  // visitorPaymentStartDate (added after this app already had live data).
  // memberPaymentStartDate mirrors whatever defaultStartMonth already was,
  // so member-month calculations don't shift. visitorPaymentStartDate
  // backfills to a date well before any real visitor could have been added,
  // so no existing visitor is retroactively excluded from pending
  // calculations by a setting that didn't exist when they were added.
  let needsSave = false;
  if (!settings.memberPaymentStartDate) {
    const [year, month] = settings.defaultStartMonth.split('-').map(Number);
    settings.memberPaymentStartDate = new Date(Date.UTC(year, month - 1, 1));
    needsSave = true;
  }
  if (!settings.visitorPaymentStartDate) {
    settings.visitorPaymentStartDate = new Date(Date.UTC(2000, 0, 1));
    needsSave = true;
  }
  // Backfill for a Settings document that predates columnDisplayStartMonth -
  // anchor the column window at the current month, i.e. from right now
  // onward, rather than retroactively expanding it back to defaultStartMonth.
  if (!settings.columnDisplayStartMonth) {
    const now = new Date();
    settings.columnDisplayStartMonth = monthKeyOf(now.getFullYear(), now.getMonth() + 1);
    needsSave = true;
  }
  // Backfill for a Settings document that predates visitorFeeHistory - seed
  // it with the current visitorFee, dated to whenever this document was
  // first created (the earliest point that amount is known to have applied
  // from), rather than "now" which would misrepresent it as a brand new
  // change.
  if (!settings.visitorFeeHistory || settings.visitorFeeHistory.length === 0) {
    settings.visitorFeeHistory = [
      { amount: settings.visitorFee, effectiveFrom: settings.createdAt || new Date() },
    ];
    needsSave = true;
  }
  // Backfill for a Settings document that predates guestFee/guestFeeHistory -
  // same reasoning as visitorFee's own backfill above.
  if (typeof settings.guestFee !== 'number') {
    settings.guestFee = DEFAULTS.guestFee;
    needsSave = true;
  }
  if (!settings.guestFeeHistory || settings.guestFeeHistory.length === 0) {
    settings.guestFeeHistory = [
      { amount: settings.guestFee, effectiveFrom: settings.createdAt || new Date() },
    ];
    needsSave = true;
  }
  if (needsSave) await settings.save();

  return settings;
}

module.exports = { getOrCreateSettings };
