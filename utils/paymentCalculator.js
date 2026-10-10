const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
const { readMembers, findMemberById } = require('./membersData');
const { loadFeeResolver, loadFeeSchedule, makeFeeResolver } = require('./feeSchedule');
const {
  buildMonthRange,
  buildMonthRangeBetween,
  buildCurrentMonthAndHistory,
  monthKeyOf,
  parseMonthKey,
  shortMonthYearLabel,
} = require('./monthRange');

async function loadMemberData(monthKeys) {
  const members = await readMembers();
  const [payments, visitors] = await Promise.all([
    Payment.find({ month: { $in: monthKeys } }).sort({ paidAt: 1 }).lean(),
    Visitor.find({}).lean(),
  ]);

  // memberId -> month -> [transaction, transaction, ...] - a month can have
  // more than one payment (different methods, or an added top-up), so this
  // groups into arrays rather than a single record per month.
  const paymentsByMember = new Map();
  for (const payment of payments) {
    if (!paymentsByMember.has(payment.memberId)) paymentsByMember.set(payment.memberId, new Map());
    const memberMonths = paymentsByMember.get(payment.memberId);
    if (!memberMonths.has(payment.month)) memberMonths.set(payment.month, []);
    memberMonths.get(payment.month).push(payment);
  }

  const visitorsByMember = new Map();
  for (const visitor of visitors) {
    if (!visitorsByMember.has(visitor.memberId)) visitorsByMember.set(visitor.memberId, []);
    visitorsByMember.get(visitor.memberId).push(visitor);
  }

  return { members, paymentsByMember, visitorsByMember };
}

// The month a member was added in the app ("YYYY-MM"), or null for members
// imported from the original roster (their join date was never recorded, so
// every tracked month applies to them as before).
function memberJoinMonthKey(member) {
  if (!member || member.importedFromFile || !member.createdAt) return null;
  const created = new Date(member.createdAt);
  return monthKeyOf(created.getFullYear(), created.getMonth() + 1);
}

// One status rule for every month everywhere (Home, sheets, history,
// export). A month is only Paid when something was actually paid and it
// covers the fee - a payment edited down to ₹0 leaves the month unpaid.
//   'paid'     - paid exactly the fee
//   'overpaid' - paid more than the fee (the extra is an adjustment)
//   'partial'  - something paid, less than the fee
//   'pending'  - nothing paid yet (or every payment edited to ₹0)
//   'no_fee'   - no fee for the month and nothing paid
function monthStatus(fee, paid) {
  if (fee <= 0) return paid > 0 ? 'overpaid' : 'no_fee';
  if (paid <= 0) return 'pending';
  if (paid < fee) return 'partial';
  return paid > fee ? 'overpaid' : 'paid';
}

function mapPaymentEntry(payment) {
  return {
    id: payment._id,
    method: payment.method,
    amount: payment.amount,
    cardLastFour: payment.cardLastFour || null,
    paidAt: payment.paidAt || null,
    editReason: payment.editReason || null,
  };
}

// Builds the {monthKey: {label, status, totalDue, amount, remaining,
// payments: [...]}} map for one member over the given month list, and
// returns the total outstanding balance across those months. A month only
// counts as 'paid' once the sum of its transactions covers totalDue - a
// partial payment (or a payment split across methods, e.g. 2,000 Cash +
// 3,000 UPI) stays 'pending' until the total reaches totalDue, but the full
// per-transaction breakdown is always included so the UI can show exactly
// what's been paid and via which method(s).
//
// [joinKey] ("YYYY-MM", optional) is the month the member was added: a month
// before it, with nothing paid, is 'not_applicable' - nothing was owed yet,
// so it's neither shown as Due nor counted in any pending total.
//
// [feeForMonth] is either a number (same fee every month) or a function
// (monthKey) => fee, so each month is measured against the fee that applied
// to THAT month (see utils/feeSchedule.js) rather than today's fee.
//
// [currentKey] ("YYYY-MM", optional) marks the live month: each month gets
// isCurrent / isUpcoming flags, and a month after it isn't owed yet - unless
// already covered it's 'upcoming' and left out of the pending total.
function buildMonthsResult(monthList, memberPaymentsByMonth, feeForMonth, joinKey = null, currentKey = null) {
  const monthsResult = {};
  let pendingAmount = 0;

  for (const { key, label } of monthList) {
    const isUpcoming = Boolean(currentKey && key > currentKey);
    const flags = currentKey ? { isCurrent: key === currentKey, isUpcoming } : {};
    const totalDue = typeof feeForMonth === 'function' ? feeForMonth(key) : feeForMonth;
    const transactions = memberPaymentsByMonth.get(key) || [];
    if (joinKey && key < joinKey && transactions.length === 0) {
      monthsResult[key] = {
        label,
        status: 'not_applicable',
        totalDue: 0,
        amount: 0,
        remaining: 0,
        paidAt: null,
        payments: [],
        ...flags,
      };
      continue;
    }
    const amountPaid = transactions.reduce((sum, t) => sum + t.amount, 0);
    const remaining = Math.max(totalDue - amountPaid, 0);
    const latestPaidAt = transactions.length
      ? transactions.reduce((latest, t) => (t.paidAt > latest ? t.paidAt : latest), transactions[0].paidAt)
      : null;
    let status = monthStatus(totalDue, amountPaid);
    if (status === 'partial') status = 'pending';
    // A future month with a fee that isn't fully paid yet isn't due yet.
    if (isUpcoming && status === 'pending') status = 'upcoming';

    monthsResult[key] = {
      label,
      // 'paid' | 'overpaid' | 'pending' (nothing or part paid) | 'no_fee'
      // | 'upcoming' (a future month, not owed yet)
      status,
      totalDue,
      amount: amountPaid,
      remaining,
      // Paid beyond the fee - shown as an adjustment, never as money owed.
      excess: Math.max(amountPaid - totalDue, 0),
      paidAt: latestPaidAt,
      payments: transactions.map(mapPaymentEntry),
      ...flags,
    };

    if (!isUpcoming) pendingAmount += remaining;
  }

  return { monthsResult, pendingAmount };
}

// Every charge this visitor has ever been billed (see Visitor.js's
// visitorChargeSchema) - ordinarily just one, fixed at whatever
// Settings.visitorFee was when the visitor was created (see
// visitorController.js's createVisitor), unaffected by any later
// Settings.visitorFee change. Each charge's paid/remaining/status comes
// only from its OWN nested payments array. [visitorFee] is only a
// fallback, synthesizing a single implicit (unpaid) charge for a visitor
// that somehow has none stored yet - should only matter in tests, since
// createVisitor always seeds one.
function chargesWithStatus(visitor, visitorFee) {
  const stored = visitor.charges && visitor.charges.length > 0
    ? visitor.charges
    : [{ amount: visitorFee, effectiveFrom: visitor.createdAt, payments: [] }];
  const sorted = [...stored].sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom));

  return sorted.map((charge) => {
    const transactions = charge.payments || [];
    const paid = transactions.reduce((sum, t) => sum + t.amount, 0);
    const remaining = Math.max(charge.amount - paid, 0);
    const latestPaidAt = transactions.length
      ? transactions.reduce((latest, t) => (t.paidAt > latest ? t.paidAt : latest), transactions[0].paidAt)
      : null;
    return {
      id: charge._id,
      amount: charge.amount,
      effectiveFrom: charge.effectiveFrom,
      paid,
      remaining,
      status: remaining <= 0 ? 'paid' : 'pending',
      paidAt: latestPaidAt,
      payments: transactions.map(mapPaymentEntry),
    };
  });
}

// A visitor's total due is the sum of every charge they've ever been billed
// (see chargesWithStatus above) - ordinarily just the one amount fixed at
// creation time, never a value read live off Settings on every request, so
// a later Settings.visitorFee change can neither retroactively "unpay" a
// charge this visitor already settled nor add a new one to them - it only
// ever affects visitors created after that point. The aggregate amount/
// remaining/status below is purely a sum across charges for list-view
// display - actually paying always targets one specific charge (see
// visitorController.js's recordVisitorPayment).
function buildVisitorStatus(visitor, visitorFee) {
  const charges = chargesWithStatus(visitor, visitorFee);
  const totalDue = charges.reduce((sum, c) => sum + c.amount, 0);
  const amountPaid = charges.reduce((sum, c) => sum + c.paid, 0);
  const remaining = charges.reduce((sum, c) => sum + c.remaining, 0);
  const isPaid = remaining <= 0;
  const latestPaidAt = charges.reduce((latest, c) => (c.paidAt && (!latest || c.paidAt > latest) ? c.paidAt : latest), null);

  return {
    id: visitor._id,
    name: visitor.name,
    type: visitor.type || 'visitor',
    email: visitor.email,
    phone: visitor.phone,
    createdAt: visitor.createdAt,
    status: isPaid ? 'paid' : 'pending',
    totalDue,
    amount: amountPaid,
    remaining,
    paidAt: latestPaidAt,
    // Flattened across every charge, newest-transaction-first is NOT
    // assumed by any caller - kept purely for backward-compatible callers
    // that want "every payment this visitor ever made" as one list (e.g.
    // exportBuilder.js's transaction-level report already reads each
    // charge's payments directly instead, this is for anything simpler).
    payments: charges.flatMap((c) => c.payments),
    charges,
  };
}

// Visitors added before Settings.visitorPaymentStartDate are grandfathered
// in - excluded from every pending/owed calculation, as if visitor-fee
// tracking simply didn't apply to them yet.
function isVisitorInScope(visitor, visitorPaymentStartDate) {
  if (!visitorPaymentStartDate) return true;
  return new Date(visitor.createdAt) >= new Date(visitorPaymentStartDate);
}

function mapVisitors(memberVisitors, visitorFee, visitorPaymentStartDate) {
  return memberVisitors
    .filter((v) => isVisitorInScope(v, visitorPaymentStartDate))
    .map((v) => buildVisitorStatus(v, visitorFee));
}

// A visitor has no stored "month" - it's incurred the month it was added,
// so that's derived from createdAt (mirrors how the mobile app already
// buckets visitors under a month in the pending-breakdown screen).
function visitorMonthKey(visitor) {
  const created = new Date(visitor.createdAt);
  return monthKeyOf(created.getFullYear(), created.getMonth() + 1);
}

// Every still-outstanding visitor CHARGE (not visitor - a visitor can have
// several independent charges, see Visitor.js) this member incurred during
// [monthKey], oldest charge first - powers "paying this month also settles
// that month's visitor charges" (see recordPayment), filling each pending
// charge in full before spilling into the next rather than splitting one
// payment thinly across several of a visitor's due records at once.
function getPendingChargesForMonth(memberVisitors, monthKey, visitorFee, visitorPaymentStartDate) {
  const inScope = memberVisitors.filter(
    (v) => visitorMonthKey(v) === monthKey && isVisitorInScope(v, visitorPaymentStartDate)
  );
  const pendingCharges = [];
  for (const visitor of inScope) {
    const { id: visitorId, charges } = buildVisitorStatus(visitor, visitorFee);
    for (const charge of charges) {
      if (charge.remaining > 0) pendingCharges.push({ visitorId, chargeId: charge.id, remaining: charge.remaining });
    }
  }
  return pendingCharges;
}

// The months the app tracks: the current month first ("This Month"), then
// every earlier month back to Settings.columnDisplayStartMonth.
function trackedMonths(settings, now = new Date()) {
  const { year: startYear, month: startMonth } = parseMonthKey(settings.columnDisplayStartMonth);
  const monthsSinceStart = Math.max(0, (now.getFullYear() * 12 + now.getMonth() + 1) - (startYear * 12 + startMonth));
  return buildCurrentMonthAndHistory(now, monthsSinceStart);
}

// The latest month with a membership fee saved (> 0) in Fee Settings, or null.
function latestConfiguredMemberMonth(schedule) {
  let latest = null;
  for (const fee of schedule.monthly.values()) {
    if (fee.role === 'member' && fee.amount > 0 && (!latest || fee.month > latest)) latest = fee.month;
  }
  return latest;
}

function addMonthsToKey(monthKey, count) {
  const { year, month } = parseMonthKey(monthKey);
  const index = year * 12 + (month - 1) + count;
  return monthKeyOf(Math.floor(index / 12), (index % 12) + 1);
}

// The Home screen's month columns, oldest first: every month from
// Settings.columnDisplayStartMonth through the current month ("This Month"),
// extended forward to the latest month whose fee has been saved in Fee
// Settings (at most MAX_UPCOMING_MONTHS ahead) - so saving a future month's
// fee adds its column automatically. Any month in between with no fee saved
// still gets its column (shown as "No fee"), keeping the order unbroken.
function homeColumnMonths(settings, schedule, now = new Date()) {
  const currentKey = monthKeyOf(now.getFullYear(), now.getMonth() + 1);
  const startKey = settings.columnDisplayStartMonth || currentKey;
  let endKey = currentKey;
  const latest = latestConfiguredMemberMonth(schedule);
  if (latest && latest > endKey) {
    const cap = addMonthsToKey(currentKey, MAX_UPCOMING_MONTHS);
    endKey = latest > cap ? cap : latest;
  }
  return buildMonthRangeBetween(startKey < endKey ? startKey : endKey, endKey).map(({ key }) => {
    const { year, month } = parseMonthKey(key);
    return { key, label: key === currentKey ? 'This Month' : shortMonthYearLabel(month, year) };
  });
}

// Builds the Home-screen member list. Its month columns (see
// homeColumnMonths) run oldest to newest, through any future month whose fee
// is saved. Total Pending is the sum of every unpaid month up to and
// including the current month (future months aren't owed yet) plus unpaid
// visitor/guest fees - so the Home screen's Pending column matches the
// member's history screen exactly. Re-derived from the system clock on every
// request.
async function buildMemberList(settings) {
  const now = new Date();
  const currentKey = monthKeyOf(now.getFullYear(), now.getMonth() + 1);
  const schedule = await loadFeeSchedule();
  const displayMonths = homeColumnMonths(settings, schedule, now);
  const resolveFee = makeFeeResolver(schedule, settings);
  const { members, paymentsByMember, visitorsByMember } = await loadMemberData(displayMonths.map((m) => m.key));
  const memberFee = (monthKey) => resolveFee('member', monthKey);

  return members.map((member) => {
    const memberPayments = paymentsByMember.get(member.id) || new Map();
    const joinKey = memberJoinMonthKey(member);
    const { monthsResult, pendingAmount } = buildMonthsResult(
      displayMonths,
      memberPayments,
      memberFee,
      joinKey,
      currentKey
    );

    const memberVisitors = visitorsByMember.get(member.id) || [];
    const visitorStatuses = mapVisitors(memberVisitors, settings.visitorFee, settings.visitorPaymentStartDate);
    const visitorPending = visitorStatuses.reduce((sum, v) => sum + v.remaining, 0);
    const totalPending = pendingAmount + visitorPending;

    return {
      id: member.id,
      name: member.name,
      phone: member.phone || '',
      totalPending,
      months: monthsResult,
      visitors: visitorStatuses,
    };
  });
}

// Builds full payment history since Settings.defaultStartMonth through the
// current month, for the Export report - independent of the Home screen's
// current-year display window, since exports need to cover past months too.
async function buildMemberHistory(settings) {
  const historicalMonths = buildMonthRange(settings.defaultStartMonth);
  const [{ members, paymentsByMember, visitorsByMember }, resolveFee] = await Promise.all([
    loadMemberData(historicalMonths.map((m) => m.key)),
    loadFeeResolver(settings),
  ]);
  const memberFee = (monthKey) => resolveFee('member', monthKey);

  return members.map((member) => {
    const memberPayments = paymentsByMember.get(member.id) || new Map();
    const { monthsResult, pendingAmount } = buildMonthsResult(
      historicalMonths,
      memberPayments,
      memberFee,
      memberJoinMonthKey(member)
    );

    const memberVisitors = visitorsByMember.get(member.id) || [];
    const visitorStatuses = mapVisitors(memberVisitors, settings.visitorFee, settings.visitorPaymentStartDate);
    const visitorPending = visitorStatuses.reduce((sum, v) => sum + v.remaining, 0);
    const totalPending = pendingAmount + visitorPending;

    return {
      id: member.id,
      name: member.name,
      totalPending,
      months: monthsResult,
      visitors: visitorStatuses,
    };
  });
}

// Builds the pending-months list for a single member - powers both the
// "Current Month" payment sheet and the Pending Breakdown sheet (opened by
// tapping the Home screen's Pending amount). Covers every tracked month
// (same window as Total Pending above), oldest first, so this list always
// adds up to the Pending figure shown for the member. The current month is
// always included even when it's already fully paid, so tapping an
// already-paid current month still opens somewhere to view (and edit) its
// payment details instead of finding "no pending months".
async function buildMemberPendingMonths(memberId, settings) {
  const now = new Date();
  const months = trackedMonths(settings, now).slice().reverse(); // oldest first
  const monthKeys = months.map((m) => m.key);
  const currentKey = monthKeyOf(now.getFullYear(), now.getMonth() + 1);

  const [payments, member, resolveFee] = await Promise.all([
    Payment.find({ memberId, month: { $in: monthKeys } }).sort({ paidAt: 1 }).lean(),
    findMemberById(memberId),
    loadFeeResolver(settings),
  ]);
  const memberPayments = new Map();
  for (const payment of payments) {
    if (!memberPayments.has(payment.month)) memberPayments.set(payment.month, []);
    memberPayments.get(payment.month).push(payment);
  }

  const { monthsResult } = buildMonthsResult(
    months,
    memberPayments,
    (monthKey) => resolveFee('member', monthKey),
    memberJoinMonthKey(member)
  );

  return Object.entries(monthsResult)
    .filter(([key, month]) => month.status === 'pending' || key === currentKey)
    .map(([monthKey, month]) => ({ monthKey, ...month }));
}

// How far ahead the Pending Breakdown's "+" can add a month for payment -
// same limit as advance payments (see paymentController.js).
const MAX_UPCOMING_MONTHS = 12;

// One upcoming month for the Pending Breakdown's "+" button, in the same
// shape as a buildMemberPendingMonths entry. A month can only be added once
// its membership fee has been saved in Fee Settings: returns
// { error, code } instead when the month is invalid or has no fee yet.
async function buildMemberUpcomingMonth(memberId, monthKey, settings, now = new Date()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey || '')) {
    return { error: 'month must be in YYYY-MM format', code: 'INVALID_MONTH' };
  }
  const currentKey = monthKeyOf(now.getFullYear(), now.getMonth() + 1);
  const { year, month } = parseMonthKey(monthKey);
  const monthsAhead = year * 12 + month - (now.getFullYear() * 12 + now.getMonth() + 1);
  if (monthKey <= currentKey) {
    return { error: 'Only an upcoming month can be added.', code: 'INVALID_MONTH' };
  }
  if (monthsAhead > MAX_UPCOMING_MONTHS) {
    return { error: `Payments can be added up to ${MAX_UPCOMING_MONTHS} months ahead.`, code: 'TOO_FAR_AHEAD' };
  }

  const label = shortMonthYearLabel(month, year);
  const [payments, resolveFee] = await Promise.all([
    Payment.find({ memberId, month: monthKey }).sort({ paidAt: 1 }).lean(),
    loadFeeResolver(settings),
  ]);
  const fee = resolveFee('member', monthKey);
  if (fee <= 0) {
    return {
      error: `The fee for ${label} is not set yet. Configure and save it in Settings → Change Fee first.`,
      code: 'FEE_NOT_CONFIGURED',
    };
  }

  const { monthsResult } = buildMonthsResult(
    [{ key: monthKey, label }],
    new Map([[monthKey, payments]]),
    () => fee
  );
  return { month: { monthKey, ...monthsResult[monthKey] } };
}

module.exports = {
  buildMemberList,
  buildMemberHistory,
  buildMemberPendingMonths,
  buildMemberUpcomingMonth,
  MAX_UPCOMING_MONTHS,
  buildVisitorStatus,
  getPendingChargesForMonth,
  memberJoinMonthKey,
  monthStatus,
  visitorMonthKey,
  isVisitorInScope,
};

