const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
const { readMembers } = require('./membersData');
const { buildMonthRange, buildCurrentMonthAndHistory, monthKeyOf } = require('./monthRange');

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
    paidAt: payment.paidAt,
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

// A visitor's fee is always evaluated against the CURRENT Settings.visitorFee
// rather than a value frozen at creation time - there's no separate "amount"
// stored on the Visitor document, so raising/lowering the fee immediately
// changes every outstanding visitor charge, mirroring how a month's totalDue
// always uses the current monthlyFee. Structurally this mirrors
// buildMonthsResult: sum the visitor's own payment transactions, and the fee
// stays 'pending' until they cover the current visitorFee.
function buildVisitorStatus(visitor, visitorFee) {
  const transactions = visitor.payments || [];
  const amountPaid = transactions.reduce((sum, t) => sum + t.amount, 0);
  const remaining = Math.max(visitorFee - amountPaid, 0);
  const isPaid = remaining <= 0;
  const latestPaidAt = transactions.length
    ? transactions.reduce((latest, t) => (t.paidAt > latest ? t.paidAt : latest), transactions[0].paidAt)
    : null;

  return {
    id: visitor._id,
    name: visitor.name,
    email: visitor.email,
    phone: visitor.phone,
    createdAt: visitor.createdAt,
    status: isPaid ? 'paid' : 'pending',
    totalDue: visitorFee,
    amount: amountPaid,
    remaining,
    paidAt: latestPaidAt,
    payments: transactions.map(mapPaymentEntry),
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

// Every still-outstanding visitor fee this member incurred during [monthKey]
// - powers "paying this month also settles that month's visitor charges"
// (see recordPayment) and any UI that needs to show the combined total.
function getPendingVisitorsForMonth(memberVisitors, monthKey, visitorFee, visitorPaymentStartDate) {
  return memberVisitors
    .filter((v) => visitorMonthKey(v) === monthKey && isVisitorInScope(v, visitorPaymentStartDate))
    .map((v) => buildVisitorStatus(v, visitorFee))
    .filter((v) => v.remaining > 0);
}

// Builds the Home-screen member list. The visible month columns are always
// "current month, then the 1 month before it" (see
// buildCurrentMonthAndHistory) - a pure rolling window that shifts by one
// position every calendar month with no manual upkeep. Total Pending is
// independent of that display window: it's the full outstanding balance
// since Settings.defaultStartMonth plus outstanding visitor fees, so a
// member's true balance still counts months that aren't shown as columns.
async function buildMemberList(settings) {
  const historicalMonths = buildMonthRange(settings.defaultStartMonth);
  const displayMonths = buildCurrentMonthAndHistory();
  const allKeys = Array.from(new Set([...historicalMonths, ...displayMonths].map((m) => m.key)));

  const { members, paymentsByMember, visitorsByMember } = await loadMemberData(allKeys);

  return members.map((member) => {
    const memberPayments = paymentsByMember.get(member.id) || new Map();
    const { pendingAmount } = buildMonthsResult(historicalMonths, memberPayments, settings.monthlyFee);
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

// Builds the full list of a single member's still-outstanding months (across
// the entire Settings.defaultStartMonth-to-current-month range, not just the
// Home screen's display window) - powers the "Current Month" payment sheet,
// which needs to show every pending month (e.g. January and May) even if
// they've scrolled out of the visible columns. The live current month is
// always included even when it's already fully paid, so tapping an
// already-paid Current Month still opens somewhere to view (and edit) its
// payment details instead of finding "no pending months".
async function buildMemberPendingMonths(memberId, settings) {
  const historicalMonths = buildMonthRange(settings.defaultStartMonth);
  const monthKeys = historicalMonths.map((m) => m.key);
  const now = new Date();
  const currentKey = monthKeyOf(now.getFullYear(), now.getMonth() + 1);

  const payments = await Payment.find({ memberId, month: { $in: monthKeys } }).sort({ paidAt: 1 }).lean();
  const memberPayments = new Map();
  for (const payment of payments) {
    if (!memberPayments.has(payment.month)) memberPayments.set(payment.month, []);
    memberPayments.get(payment.month).push(payment);
  }

  const { monthsResult } = buildMonthsResult(historicalMonths, memberPayments, settings.monthlyFee);

  return Object.entries(monthsResult)
    .filter(([key, month]) => month.status === 'pending' || key === currentKey)
    .map(([monthKey, month]) => ({ monthKey, ...month }));
}

module.exports = {
  buildMemberList,
  buildMemberHistory,
  buildMemberPendingMonths,
  buildVisitorStatus,
  getPendingVisitorsForMonth,
  visitorMonthKey,
  isVisitorInScope,
};
