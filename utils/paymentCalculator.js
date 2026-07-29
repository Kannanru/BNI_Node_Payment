const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
const { readMembers } = require('./membersData');
const { buildMonthRange, buildCurrentMonthAndHistory, monthKeyOf, parseMonthKey } = require('./monthRange');

async function loadMemberData(monthKeys) {
  const members = readMembers();
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
function buildMonthsResult(monthList, memberPaymentsByMonth, totalDue) {
  const monthsResult = {};
  let pendingAmount = 0;

  for (const { key, label } of monthList) {
    const transactions = memberPaymentsByMonth.get(key) || [];
    const amountPaid = transactions.reduce((sum, t) => sum + t.amount, 0);
    const remaining = Math.max(totalDue - amountPaid, 0);
    const isPaid = remaining <= 0;
    const latestPaidAt = transactions.length
      ? transactions.reduce((latest, t) => (t.paidAt > latest ? t.paidAt : latest), transactions[0].paidAt)
      : null;

    monthsResult[key] = {
      label,
      status: isPaid ? 'paid' : 'pending',
      totalDue,
      amount: amountPaid,
      remaining,
      paidAt: latestPaidAt,
      payments: transactions.map(mapPaymentEntry),
    };

    pendingAmount += remaining;
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

// Builds the Home-screen member list. Two independent month windows are in
// play here, deliberately kept separate:
//   - displayMonths: the visible table columns, spanning every month from
//     Settings.columnDisplayStartMonth through the live current month
//     (current month first, labelled "This Month", then each prior month in
//     reverse-chronological order) - grows by one column every 1st with no
//     manual upkeep, purely as historical context.
//   - currentMonthOnly: what Total Pending is computed from - always just
//     the live current month, never accumulating past months, so the
//     headline "Pending" figure only ever reflects what's due right now.
// Both are re-derived from the system clock on every request.
async function buildMemberList(settings) {
  const now = new Date();
  const currentMonthOnly = buildCurrentMonthAndHistory(now, 0);
  const { year: startYear, month: startMonth } = parseMonthKey(settings.columnDisplayStartMonth);
  const monthsSinceStart = Math.max(0, (now.getFullYear() * 12 + now.getMonth() + 1) - (startYear * 12 + startMonth));
  const displayMonths = buildCurrentMonthAndHistory(now, monthsSinceStart);
  const allKeys = Array.from(new Set([...currentMonthOnly, ...displayMonths].map((m) => m.key)));

  const { members, paymentsByMember, visitorsByMember } = await loadMemberData(allKeys);

  return members.map((member) => {
    const memberPayments = paymentsByMember.get(member.id) || new Map();
    const { pendingAmount } = buildMonthsResult(currentMonthOnly, memberPayments, settings.monthlyFee);
    const { monthsResult } = buildMonthsResult(displayMonths, memberPayments, settings.monthlyFee);

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

// Builds full payment history since Settings.defaultStartMonth through the
// current month, for the Export report - independent of the Home screen's
// current-year display window, since exports need to cover past months too.
async function buildMemberHistory(settings) {
  const historicalMonths = buildMonthRange(settings.defaultStartMonth);
  const { members, paymentsByMember, visitorsByMember } = await loadMemberData(
    historicalMonths.map((m) => m.key)
  );

  return members.map((member) => {
    const memberPayments = paymentsByMember.get(member.id) || new Map();
    const { monthsResult, pendingAmount } = buildMonthsResult(historicalMonths, memberPayments, settings.monthlyFee);

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
// tapping the Home screen's Pending amount). Deliberately scoped to just the
// live current month, matching Total Pending above: older months (even if
// still unpaid) are not surfaced here, so this list and the headline Pending
// figure a member sees always agree with each other. The current month is
// always included even when it's already fully paid, so tapping an
// already-paid current month still opens somewhere to view (and edit) its
// payment details instead of finding "no pending months".
async function buildMemberPendingMonths(memberId, settings) {
  const now = new Date();
  const currentMonthOnly = buildCurrentMonthAndHistory(now, 0);
  const monthKeys = currentMonthOnly.map((m) => m.key);
  const currentKey = monthKeyOf(now.getFullYear(), now.getMonth() + 1);

  const payments = await Payment.find({ memberId, month: { $in: monthKeys } }).sort({ paidAt: 1 }).lean();
  const memberPayments = new Map();
  for (const payment of payments) {
    if (!memberPayments.has(payment.month)) memberPayments.set(payment.month, []);
    memberPayments.get(payment.month).push(payment);
  }

  const { monthsResult } = buildMonthsResult(currentMonthOnly, memberPayments, settings.monthlyFee);

  return Object.entries(monthsResult)
    .filter(([key, month]) => month.status === 'pending' || key === currentKey)
    .map(([monthKey, month]) => ({ monthKey, ...month }));
}

module.exports = {
  buildMemberList,
  buildMemberHistory,
  buildMemberPendingMonths,
  buildVisitorStatus,
  getPendingChargesForMonth,
  visitorMonthKey,
  isVisitorInScope,
};

