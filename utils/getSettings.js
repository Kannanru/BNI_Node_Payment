const Settings = require('../models/Settings');

// These are pure calendar dates (no time-of-day meaning), so they're always
// constructed as UTC midnight via Date.UTC - constructing with `new
// Date(year, month, day)` instead would use the server's local timezone,
// which then shifts to the previous/next day once serialized back out via
// toISOString() (see settingsController.js's serialize()) unless the server
// happens to run in UTC.
const DEFAULTS = {
  key: 'app_settings',
  defaultStartMonth: `${new Date().getFullYear()}-01`,
  monthlyFee: 100,
  visitorFee: 50,
  memberPaymentStartDate: new Date(Date.UTC(new Date().getFullYear(), 0, 1)),
  visitorPaymentStartDate: new Date(Date.UTC(new Date().getFullYear(), 0, 1)),
};

// Settings is a singleton document; create it with sane defaults on first read.
async function getOrCreateSettings() {
  let settings = await Settings.findOne({ key: 'app_settings' });
  if (!settings) {
    settings = await Settings.create(DEFAULTS);
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
  if (needsSave) await settings.save();

  return settings;
}

module.exports = { getOrCreateSettings };
