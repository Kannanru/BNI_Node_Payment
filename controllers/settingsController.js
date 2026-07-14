const Settings = require('../models/Settings');
const { getOrCreateSettings } = require('../utils/getSettings');
const { monthKeyOf } = require('../utils/monthRange');

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function serialize(settings) {
  // Most-recent-first, so the Settings screen can show "currently ₹X,
  // effective from <date>" as the first entry and the rest as history.
  const visitorFeeHistory = [...(settings.visitorFeeHistory || [])]
    .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))
    .map((entry) => ({ amount: entry.amount, effectiveFrom: entry.effectiveFrom.toISOString().slice(0, 10) }));

  return {
    defaultStartMonth: settings.defaultStartMonth,
    monthlyFee: settings.monthlyFee,
    visitorFee: settings.visitorFee,
    visitorFeeHistory,
    memberPaymentStartDate: settings.memberPaymentStartDate.toISOString().slice(0, 10),
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
    const { monthlyFee, visitorFee, memberPaymentStartDate } = req.body;

    if (!DATE_ONLY_REGEX.test(memberPaymentStartDate || '')) {
      return res.status(400).json({ message: 'memberPaymentStartDate must be in YYYY-MM-DD format' });
    }
    if (typeof monthlyFee !== 'number' || monthlyFee < 0) {
      return res.status(400).json({ message: 'monthlyFee must be a non-negative number' });
    }
    if (typeof visitorFee !== 'number' || visitorFee < 0) {
      return res.status(400).json({ message: 'visitorFee must be a non-negative number' });
    }

    const memberStart = new Date(memberPaymentStartDate);
    if (Number.isNaN(memberStart.getTime())) {
      return res.status(400).json({ message: 'Invalid start date' });
    }

    const existing = await getOrCreateSettings();

    // Mongo requires an update document to be either all plain fields or
    // all operators, never mixed at the top level - $set holds the former
    // so $push can be added alongside it below when needed.
    const update = {
      $set: {
        // defaultStartMonth is derived from memberPaymentStartDate here,
        // then read as-is by every existing month-range calculation - see
        // models/Settings.js.
        defaultStartMonth: monthKeyOf(memberStart.getFullYear(), memberStart.getMonth() + 1),
        monthlyFee,
        visitorFee,
        memberPaymentStartDate: memberStart,
        // visitorPaymentStartDate is no longer editable from the Settings
        // screen (Visitor config has no Starting Month field) - left
        // untouched here, so it keeps whatever value it already has.
      },
    };

    // Only a genuine change gets its own history entry/effective date - not
    // every save (e.g. re-saving monthlyFee alone shouldn't add a
    // no-op "changed to the same amount" row). This history is a pure audit
    // trail of what visitorFee has been set to and when - it does NOT
    // retroactively touch any existing visitor's charge (see
    // visitorController.js's createVisitor: each visitor's charge amount is
    // fixed to whatever visitorFee was at the moment THEY were created, and
    // never changes after that no matter how many times this value is
    // updated later). Only a visitor created after this point picks up the
    // new amount.
    const visitorFeeChanged = visitorFee !== existing.visitorFee;
    if (visitorFeeChanged) {
      update.$push = { visitorFeeHistory: { amount: visitorFee, effectiveFrom: new Date() } };
    }

    const settings = await Settings.findOneAndUpdate({ key: 'app_settings' }, update, { new: true });

    res.json(serialize(settings));
  } catch (err) {
    next(err);
  }
}

module.exports = { getSettings, updateSettings };
