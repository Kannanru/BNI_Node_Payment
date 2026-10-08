const MonthlyFee = require('../models/MonthlyFee');
const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
const Settings = require('../models/Settings');
const { getOrCreateSettings } = require('../utils/getSettings');
const { actorFrom } = require('../utils/audit');
const {
  ROLES,
  LEGACY_FIELD,
  currentMonthKey,
  loadFeeSchedule,
  makeFeeResolver,
  currentFees,
} = require('../utils/feeSchedule');

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function serializeRow(row, nowMonth) {
  return {
    id: String(row._id),
    role: row.role,
    effectiveMonth: row.effectiveMonth,
    amount: row.amount,
    note: row.note || null,
    createdByName: row.createdBy?.name || null,
    createdAt: row.createdAt,
    updatedByName: row.updatedBy?.name || null,
    updatedAt: row.updatedAt,
    previousAmounts: (row.previousAmounts || []).map((p) => ({
      amount: p.amount,
      changedAt: p.changedAt,
      changedByName: p.changedBy?.name || null,
    })),
    // 'past' rows are locked; the current month and 'upcoming' rows can change.
    status: row.effectiveMonth < nowMonth ? 'past' : row.effectiveMonth === nowMonth ? 'current' : 'upcoming',
  };
}

// The full schedule for every role (newest first) plus the fee in effect
// this month - powers the Settings screen's Fee Schedule cards.
async function buildFeeOverview(settings) {
  const schedule = await loadFeeSchedule();
  const resolve = makeFeeResolver(schedule, settings);
  const nowMonth = currentMonthKey();
  const out = {};
  for (const role of ROLES) {
    out[role] = [...schedule[role]].reverse().map((row) => serializeRow(row, nowMonth));
  }
  return { currentMonth: nowMonth, current: currentFees(resolve), schedule: out };
}

// Keeps the old single-value Settings fields equal to THIS month's fees, for
// older app versions that still read them. Also appends to the old
// visitor/guest fee history lists when this month's amount changed, as before.
async function syncLegacySettingsFees() {
  const settings = await getOrCreateSettings();
  const fees = currentFees(makeFeeResolver(await loadFeeSchedule(), settings));
  const update = { $set: {} };
  const push = {};
  for (const role of ROLES) {
    const field = LEGACY_FIELD[role];
    if (settings[field] !== fees[role]) {
      update.$set[field] = fees[role];
      if (role === 'visitor') push.visitorFeeHistory = { amount: fees[role], effectiveFrom: new Date() };
      if (role === 'guest') push.guestFeeHistory = { amount: fees[role], effectiveFrom: new Date() };
    }
  }
  if (Object.keys(push).length) update.$push = push;
  if (Object.keys(update.$set).length || update.$push) {
    await Settings.updateOne({ key: 'app_settings' }, update);
  }
}

// Older single-fee API (POST /api/fees, and Settings PUT from older app
// versions): sets the fee for [effectiveMonth] ONLY - the current month or a
// later one - exactly like saving that one month in Fee Settings. Refused if
// the month already has payments (its fee is locked). Returns { row } or
// { error, status }.
async function applyFeeChange({ role, effectiveMonth, amount, actor }) {
  if (!ROLES.includes(role)) return { status: 400, error: `role must be one of ${ROLES.join(', ')}` };
  if (!MONTH_REGEX.test(effectiveMonth || '')) return { status: 400, error: 'effectiveMonth must be in YYYY-MM format' };
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return { status: 400, error: 'amount must be a non-negative number' };
  }
  if (effectiveMonth < currentMonthKey()) {
    return { status: 400, error: 'Use Fee Settings to set the fee of an earlier month.' };
  }
  const locked = await monthsWithPayments(role, [effectiveMonth]);
  if (locked.size) {
    return {
      status: 409,
      error: `Payments are already recorded for ${monthName(effectiveMonth)} - the fee for a month with payments can't be changed.`,
    };
  }

  let row = await MonthlyFee.findOne({ role, month: effectiveMonth });
  if (!row) {
    row = await MonthlyFee.create({ role, month: effectiveMonth, amount, createdBy: actor, updatedBy: actor });
  } else if (row.amount !== amount) {
    row.history.push({ amount: row.amount, changedAt: new Date(), changedBy: actor });
    row.amount = amount;
    row.updatedBy = actor;
    await row.save();
  }
  await syncLegacySettingsFees();
  return { row };
}

// The months (out of [monthKeys]) that already have at least one payment
// recorded for [role] - such a month's fee is locked:
//   member  -> any membership payment for that month (any member, including
//              advance payments and members since deleted);
//   visitor/guest -> any fee payment by a visitor/guest added in that month
//              (their fee is the one for the month they were added).
async function monthsWithPayments(role, monthKeys) {
  const wanted = new Set(monthKeys);
  if (!wanted.size) return new Set();
  if (role === 'member') {
    const months = await Payment.distinct('month', { month: { $in: [...wanted] } });
    return new Set(months);
  }
  const sorted = [...wanted].sort();
  const from = new Date(`${sorted[0]}-01T00:00:00`);
  const [ly, lm] = sorted[sorted.length - 1].split('-').map(Number);
  const to = new Date(ly, lm, 1); // first day after the last month
  const typeFilter = role === 'guest' ? { type: 'guest' } : { $or: [{ type: 'visitor' }, { type: { $exists: false } }] };
  const paid = await Visitor.find({
    ...typeFilter,
    createdAt: { $gte: from, $lt: to },
    'charges.payments.0': { $exists: true },
  })
    .setOptions({ withDeleted: true })
    .select('createdAt')
    .lean();
  const out = new Set();
  for (const v of paid) {
    const d = new Date(v.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (wanted.has(key)) out.add(key);
  }
  return out;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthName(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

// The 12 months of [year] for [role]: each month's fee and where it comes
// from - 'set' when a fee was saved for that exact month (an edit changes
// that month only), otherwise 'default' (the general fee schedule). A month
// is editable until at least one payment is recorded for it; after that it
// is locked (see monthsWithPayments).
async function buildYearView(role, year, settings) {
  const keys = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const [schedule, paidMonths] = await Promise.all([loadFeeSchedule(), monthsWithPayments(role, keys)]);
  const resolve = makeFeeResolver(schedule, settings);
  const nowMonth = currentMonthKey();
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const key = keys[m - 1];
    const own = schedule.monthly.get(`${role}|${key}`);
    const hasPayments = paidMonths.has(key);
    months.push({
      month: key,
      name: MONTH_NAMES[m - 1],
      amount: resolve(role, key),
      source: own ? 'set' : 'default',
      hasPayments,
      locked: hasPayments,
      editable: !hasPayments,
      isPast: key < nowMonth,
      isCurrent: key === nowMonth,
      setByName: own ? (own.updatedBy || own.createdBy)?.name || null : null,
      setAt: own ? own.updatedAt || own.createdAt : null,
      previousAmounts: own
        ? own.history.map((h) => ({ amount: h.amount, changedAt: h.changedAt, changedByName: h.changedBy?.name || null }))
        : [],
    });
  }
  return { role, year, currentMonth: nowMonth, months };
}

async function getFeeMonths(req, res, next) {
  try {
    const role = String(req.query.role || '');
    const year = Number(req.query.year);
    if (!ROLES.includes(role)) return res.status(400).json({ message: `role must be one of ${ROLES.join(', ')}` });
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ message: 'year must be a valid year' });
    res.json(await buildYearView(role, year, await getOrCreateSettings()));
  } catch (err) {
    next(err);
  }
}

// Saves the fee for one or more specific months ([{ month, amount }]) - each
// applies to THAT month only and never changes any other month. A month that
// already has a saved fee is updated, with the previous amount (and who/when)
// kept in its history. Every entry is validated before anything is written.
async function saveFeeMonths(req, res, next) {
  try {
    const { role, entries } = req.body;
    if (!ROLES.includes(role)) return res.status(400).json({ message: `role must be one of ${ROLES.join(', ')}` });
    if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ message: 'entries must be a non-empty list' });

    const seen = new Set();
    for (const e of entries) {
      if (!MONTH_REGEX.test(e?.month || '')) return res.status(400).json({ message: 'Each entry needs a month in YYYY-MM format' });
      if (seen.has(e.month)) return res.status(400).json({ message: `${monthName(e.month)} appears more than once` });
      seen.add(e.month);
      if (typeof e.amount !== 'number' || !Number.isFinite(e.amount) || e.amount < 0) {
        return res.status(400).json({ message: `Enter a valid amount for ${monthName(e.month)}` });
      }
    }
    // A month with any payment recorded is locked - checked for every entry
    // before anything is written.
    const locked = await monthsWithPayments(role, [...seen]);
    if (locked.size) {
      return res.status(409).json({
        message: `Payments are already recorded for ${[...locked].sort().map(monthName).join(', ')} - the fee for a month with payments can't be changed.`,
      });
    }

    const actor = actorFrom(req);
    for (const e of entries) {
      const existing = await MonthlyFee.findOne({ role, month: e.month });
      if (!existing) {
        await MonthlyFee.create({ role, month: e.month, amount: e.amount, createdBy: actor, updatedBy: actor });
      } else if (existing.amount !== e.amount) {
        // Keep the amount being replaced, with who replaced it and when.
        existing.history.push({ amount: existing.amount, changedAt: new Date(), changedBy: actor });
        existing.amount = e.amount;
        existing.updatedBy = actor;
        await existing.save();
      }
    }
    await syncLegacySettingsFees();

    const year = Number(entries[0].month.slice(0, 4));
    const settings = await getOrCreateSettings();
    res.status(201).json({ view: await buildYearView(role, year, settings), overview: await buildFeeOverview(settings) });
  } catch (err) {
    next(err);
  }
}

async function getFees(req, res, next) {
  try {
    res.json(await buildFeeOverview(await getOrCreateSettings()));
  } catch (err) {
    next(err);
  }
}

async function setFee(req, res, next) {
  try {
    const { role, effectiveMonth, amount } = req.body;
    const note = req.body.note === undefined ? undefined : String(req.body.note || '').trim() || undefined;
    const result = await applyFeeChange({ role, effectiveMonth, amount, note, actor: actorFrom(req) });
    if (result.error) return res.status(result.status).json({ message: result.error });
    res.status(201).json(await buildFeeOverview(await getOrCreateSettings()));
  } catch (err) {
    next(err);
  }
}

module.exports = { getFees, setFee, getFeeMonths, saveFeeMonths, applyFeeChange, buildFeeOverview };
