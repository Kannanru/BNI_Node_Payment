const Settings = require('../models/Settings');
const { getOrCreateSettings } = require('../utils/getSettings');
const { monthKeyOf } = require('../utils/monthRange');

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function serialize(settings) {
  return {
    defaultStartMonth: settings.defaultStartMonth,
    monthlyFee: settings.monthlyFee,
    visitorFee: settings.visitorFee,
    memberPaymentStartDate: settings.memberPaymentStartDate.toISOString().slice(0, 10),
    visitorPaymentStartDate: settings.visitorPaymentStartDate.toISOString().slice(0, 10),
  };
}

async function getSettings(req, res, next) {
  try {
    const settings = await getOrCreateSettings();
    res.json(serialize(settings));
  } catch (err) {
    next(err);
  }
}

async function updateSettings(req, res, next) {
  try {
    const { monthlyFee, visitorFee, memberPaymentStartDate, visitorPaymentStartDate } = req.body;

    if (!DATE_ONLY_REGEX.test(memberPaymentStartDate || '')) {
      return res.status(400).json({ message: 'memberPaymentStartDate must be in YYYY-MM-DD format' });
    }
    if (!DATE_ONLY_REGEX.test(visitorPaymentStartDate || '')) {
      return res.status(400).json({ message: 'visitorPaymentStartDate must be in YYYY-MM-DD format' });
    }
    if (typeof monthlyFee !== 'number' || monthlyFee < 0) {
      return res.status(400).json({ message: 'monthlyFee must be a non-negative number' });
    }
    if (typeof visitorFee !== 'number' || visitorFee < 0) {
      return res.status(400).json({ message: 'visitorFee must be a non-negative number' });
    }

    const memberStart = new Date(memberPaymentStartDate);
    const visitorStart = new Date(visitorPaymentStartDate);
    if (Number.isNaN(memberStart.getTime()) || Number.isNaN(visitorStart.getTime())) {
      return res.status(400).json({ message: 'Invalid start date' });
    }

    await getOrCreateSettings();
    // defaultStartMonth is derived from memberPaymentStartDate here, then
    // read as-is by every existing month-range calculation - see
    // models/Settings.js.
    const settings = await Settings.findOneAndUpdate(
      { key: 'app_settings' },
      {
        defaultStartMonth: monthKeyOf(memberStart.getFullYear(), memberStart.getMonth() + 1),
        monthlyFee,
        visitorFee,
        memberPaymentStartDate: memberStart,
        visitorPaymentStartDate: visitorStart,
      },
      { new: true }
    );

    res.json(serialize(settings));
  } catch (err) {
    next(err);
  }
}

module.exports = { getSettings, updateSettings };
