const Settings = require('../models/Settings');
const { getOrCreateSettings } = require('../utils/getSettings');
const { monthKeyOf } = require('../utils/monthRange');
const { actorFrom } = require('../utils/audit');
const { LEGACY_FIELD, currentMonthKey, loadFeeResolver, currentFees } = require('../utils/feeSchedule');
const { applyFeeChange, buildFeeOverview } = require('./feeController');

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Shared by visitorFeeHistory and guestFeeHistory - both are sorted and
// date-truncated identically, see serialize()'s doc comment on the field.
function sortedHistory(history) {
  return [...(history || [])]
    .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))
    .map((entry) => ({ amount: entry.amount, effectiveFrom: entry.effectiveFrom.toISOString().slice(0, 10) }));
}

// monthlyFee/visitorFee/guestFee are THIS month's fees from the fee schedule
// (each month's own fee is resolved separately - see utils/feeSchedule.js);
// `fees` is the full month-wise schedule for the Settings screen.
async function serialize(settings) {
  const fees = await buildFeeOverview(settings);
  return {
    defaultStartMonth: settings.defaultStartMonth,
    monthlyFee: fees.current.member,
    visitorFee: fees.current.visitor,
    visitorFeeHistory: sortedHistory(settings.visitorFeeHistory),
    guestFee: fees.current.guest,
    guestFeeHistory: sortedHistory(settings.guestFeeHistory),
    memberPaymentStartDate: settings.memberPaymentStartDate.toISOString().slice(0, 10),
    fees,
  };
}

async function getSettings(req, res, next) {
  try {
    const settings = await getOrCreateSettings();
    res.json(await serialize(settings));
  } catch (err) {
    next(err);
  }
}

async function updateSettings(req, res, next) {
  try {
    const { monthlyFee, visitorFee, guestFee, memberPaymentStartDate } = req.body;

    if (!DATE_ONLY_REGEX.test(memberPaymentStartDate || '')) {
      return res.status(400).json({ message: 'memberPaymentStartDate must be in YYYY-MM-DD format' });
    }
    // Fees are optional here now - they're managed month-wise through
    // /api/fees. Older app versions still send all three; each is checked
    // only if sent.
    const sentFees = { member: monthlyFee, visitor: visitorFee, guest: guestFee };
    for (const [role, value] of Object.entries(sentFees)) {
      if (value !== undefined && (typeof value !== 'number' || value < 0)) {
        return res.status(400).json({ message: `${LEGACY_FIELD[role]} must be a non-negative number` });
      }
    }

    const memberStart = new Date(memberPaymentStartDate);
    if (Number.isNaN(memberStart.getTime())) {
      return res.status(400).json({ message: 'Invalid start date' });
    }

    await Settings.updateOne(
      { key: 'app_settings' },
      {
        $set: {
          // defaultStartMonth is derived from memberPaymentStartDate here,
          // then read as-is by every existing month-range calculation - see
          // models/Settings.js.
          defaultStartMonth: monthKeyOf(memberStart.getFullYear(), memberStart.getMonth() + 1),
          memberPaymentStartDate: memberStart,
          // visitorPaymentStartDate is no longer editable from the Settings
          // screen - left untouched, so it keeps whatever value it has.
        },
      }
    );

    // A fee sent by an older app that differs from this month's fee becomes
    // a fee change from the CURRENT month onward - never applied to any
    // earlier month.
    const current = currentFees(await loadFeeResolver(await getOrCreateSettings()));
    for (const [role, value] of Object.entries(sentFees)) {
      if (value !== undefined && value !== current[role]) {
        const result = await applyFeeChange({
          role,
          effectiveMonth: currentMonthKey(),
          amount: value,
          actor: actorFrom(req),
        });
        if (result.error) return res.status(result.status).json({ message: result.error });
      }
    }

    res.json(await serialize(await getOrCreateSettings()));
  } catch (err) {
    next(err);
  }
}

module.exports = { getSettings, updateSettings };
