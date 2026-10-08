const FeeSchedule = require('../models/FeeSchedule');
const MonthlyFee = require('../models/MonthlyFee');
const { monthKeyOf } = require('./monthRange');

const ROLES = ['member', 'visitor', 'guest'];
// The single-value Settings field each role used before fee schedules - only
// a fallback for a database that somehow has no schedule rows yet.
const LEGACY_FIELD = { member: 'monthlyFee', visitor: 'visitorFee', guest: 'guestFee' };

function currentMonthKey(now = new Date()) {
  return monthKeyOf(now.getFullYear(), now.getMonth() + 1);
}

// All schedule rows, grouped by role, oldest effectiveMonth first, plus every
// month-specific fee (models/MonthlyFee.js) in `schedule.monthly`, keyed
// "role|YYYY-MM".
async function loadFeeSchedule() {
  const [rows, monthly] = await Promise.all([
    FeeSchedule.find({}).sort({ effectiveMonth: 1 }).lean(),
    MonthlyFee.find({}).lean(),
  ]);
  const schedule = { member: [], visitor: [], guest: [], monthly: new Map() };
  for (const row of rows) schedule[row.role].push(row);
  for (const m of monthly) schedule.monthly.set(`${m.role}|${m.month}`, m);
  return schedule;
}

// The fee for [monthKey] for [role] is ONLY the fee configured for exactly
// that month (models/MonthlyFee.js). A month with no fee configured costs 0
// until a fee is saved for it. (Months that already had payments when this
// rule was introduced were given their fee at that time - see
// seed/ensureMasterData.js#ensureLockedMonthFees.)
function feeFromSchedule(schedule, role, monthKey) {
  const own = schedule.monthly?.get(`${role}|${monthKey}`);
  return own ? own.amount : 0;
}

// The older "fee from a month onward" schedule (models/FeeSchedule.js) - no
// longer used for any calculation. Kept only so the one-time migration can
// record what locked months were being charged under it.
function levelFeeFromSchedule(schedule, role, monthKey) {
  const rows = schedule[role] || [];
  if (!rows.length) return null;
  let fee = rows[0].amount;
  for (const row of rows) {
    if (row.effectiveMonth <= monthKey) fee = row.amount;
    else break;
  }
  return fee;
}

// One loaded schedule turned into a lookup function (role, monthKey) => fee.
// eslint-disable-next-line no-unused-vars
function makeFeeResolver(schedule, settings) {
  return (role, monthKey) => feeFromSchedule(schedule, role, monthKey);
}

async function loadFeeResolver(settings) {
  return makeFeeResolver(await loadFeeSchedule(), settings);
}

// The fees in effect this month, per role.
function currentFees(resolve, now = new Date()) {
  const month = currentMonthKey(now);
  return { member: resolve('member', month), visitor: resolve('visitor', month), guest: resolve('guest', month) };
}

module.exports = {
  ROLES,
  LEGACY_FIELD,
  currentMonthKey,
  loadFeeSchedule,
  feeFromSchedule,
  levelFeeFromSchedule,
  makeFeeResolver,
  loadFeeResolver,
  currentFees,
};
