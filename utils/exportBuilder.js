const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
const { readMembers } = require('./membersData');
const { buildMonthRangeBetween, monthKeyOf, parseMonthKey, shortMonthYearLabel } = require('./monthRange');
const { visitorMonthKey, isVisitorInScope } = require('./paymentCalculator');

function formatDate(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function formatDateTime(date) {
  if (!date) return '';
  const d = new Date(date);
  return `${d.toLocaleDateString('en-CA')} ${d.toLocaleTimeString('en-GB')}`;
}

function methodLabel(method) {
  if (method === 'upi') return 'UPI';
  if (method === 'card') return 'Card';
  if (method === 'cash') return 'Cash';
  return '';
}

function paidAtMonthKey(date) {
  const d = new Date(date);
  return monthKeyOf(d.getFullYear(), d.getMonth() + 1);
}

function statusOf(paid, expected) {
  if (paid >= expected && expected > 0) return 'Paid';
  if (paid > 0) return 'Partial';
  return 'Pending';
}

// Distinct, order-preserving values joined for a cell that summarizes
// several transactions at once (e.g. a month split across Cash + UPI).
function joinUnique(values) {
  return [...new Set(values.filter(Boolean))].join('; ');
}

function joinAll(values) {
  return values.filter(Boolean).join('; ');
}

// One member's month-column-group values, in the fixed per-month column
// order: Status, Paid, Pending, Payment Date/Time, Method, Collected By,
// Remarks.
function monthCells(transactions, monthlyFee) {
  const paid = transactions.reduce((sum, t) => sum + t.amount, 0);
  const remaining = Math.max(monthlyFee - paid, 0);
  return {
    cells: [
      statusOf(paid, monthlyFee),
      paid,
      remaining,
      joinAll(transactions.map((t) => formatDateTime(t.paidAt))),
      joinUnique(transactions.map((t) => methodLabel(t.method))),
      joinUnique(transactions.map((t) => t.recordedByName)),
      joinAll(transactions.map((t) => t.remarks || t.editReason)),
    ],
    paid,
    remaining,
  };
}

// One visitor's column-group values: Name, Contact, Status, Paid, Pending,
// Payment Date/Time, Method, Collected By, Remarks.
function visitorCells(visitor, visitorFee) {
  const transactions = visitor.payments || [];
  const paid = transactions.reduce((sum, t) => sum + t.amount, 0);
  const remaining = Math.max(visitorFee - paid, 0);
  const contact = [visitor.email, visitor.phone].filter(Boolean).join(' / ');
  return {
    cells: [
      visitor.name,
      contact,
      statusOf(paid, visitorFee),
      paid,
      remaining,
      joinAll(transactions.map((t) => formatDateTime(t.paidAt))),
      joinUnique(transactions.map((t) => methodLabel(t.method))),
      joinUnique(transactions.map((t) => t.recordedByName)),
      joinAll(transactions.map((t) => t.remarks || t.editReason)),
    ],
    paid,
    remaining,
  };
}

const MONTH_GROUP_HEADERS = ['Status', 'Paid Amount', 'Pending Amount', 'Payment Date/Time', 'Payment Method', 'Collected By', 'Remarks'];
const VISITOR_GROUP_HEADERS = [
  'Name',
  'Contact',
  'Status',
  'Paid Amount',
  'Pending Amount',
  'Payment Date/Time',
  'Payment Method',
  'Collected By',
  'Remarks',
];

// Builds one row per member for the inclusive [fromMonth, toMonth] range,
// with every record about that member (each month's payment status, and
// every relevant visitor's fee status) laid out in its own columns rather
// than as separate rows. Month and visitor column groups are generated
// dynamically: one group of MONTH_GROUP_HEADERS per month in range, and one
// group of VISITOR_GROUP_HEADERS per visitor slot up to the most visitors
// any single member has in this export - members with fewer are simply
// blank in the remaining slots.
async function buildMemberExportSheet({ fromMonth, toMonth, settings }) {
  const monthList = buildMonthRangeBetween(fromMonth, toMonth);
  const monthKeys = monthList.map((m) => m.key);
  const monthKeySet = new Set(monthKeys);

  const members = readMembers();
  const memberIds = members.map((m) => m.id);

  const [payments, visitors] = await Promise.all([
    Payment.find({ memberId: { $in: memberIds }, month: { $in: monthKeys } })
      .sort({ paidAt: 1 })
      .lean(),
    Visitor.find({ memberId: { $in: memberIds } }).lean(),
  ]);

  const paymentsByMemberMonth = new Map(); // memberId -> month -> [payments]
  for (const payment of payments) {
    if (!paymentsByMemberMonth.has(payment.memberId)) paymentsByMemberMonth.set(payment.memberId, new Map());
    const byMonth = paymentsByMemberMonth.get(payment.memberId);
    if (!byMonth.has(payment.month)) byMonth.set(payment.month, []);
    byMonth.get(payment.month).push(payment);
  }

  const visitorsByMember = new Map();
  for (const visitor of visitors) {
    if (!visitorsByMember.has(visitor.memberId)) visitorsByMember.set(visitor.memberId, []);
    visitorsByMember.get(visitor.memberId).push(visitor);
  }

  // Only visitors relevant to this export - in scope of
  // visitorPaymentStartDate, and either incurred within the range or paid
  // toward within the range - same inclusion rule the row-per-transaction
  // export used, just pre-computed once per member here since the row
  // shape needs the final per-member visitor list up front.
  function relevantVisitorsFor(memberId) {
    const memberVisitors = (visitorsByMember.get(memberId) || []).filter((v) =>
      isVisitorInScope(v, settings.visitorPaymentStartDate)
    );
    return memberVisitors.filter((v) => {
      const incurredInRange = monthKeySet.has(visitorMonthKey(v));
      const hasTxInRange = (v.payments || []).some((t) => monthKeySet.has(paidAtMonthKey(t.paidAt)));
      return incurredInRange || hasTxInRange;
    });
  }

  const relevantVisitorsByMember = new Map();
  let maxVisitors = 0;
  for (const member of members) {
    const relevant = relevantVisitorsFor(member.id);
    relevantVisitorsByMember.set(member.id, relevant);
    maxVisitors = Math.max(maxVisitors, relevant.length);
  }

  // "Jun/26" etc. - the export's month labels always carry the year (unlike
  // buildMonthRangeBetween's own bare "June"), since a report range can
  // span more than one calendar year and "June" alone would be ambiguous
  // between them. Matches the Home screen's month column format too.
  const headers = ['Member Name', 'Total Expected Amount', 'Total Paid Amount', 'Total Pending Amount', 'Overall Status'];
  for (const { key } of monthList) {
    const { year, month } = parseMonthKey(key);
    const label = shortMonthYearLabel(month, year);
    for (const h of MONTH_GROUP_HEADERS) headers.push(`${label} ${h}`);
  }
  for (let i = 1; i <= maxVisitors; i += 1) {
    for (const h of VISITOR_GROUP_HEADERS) headers.push(`Visitor ${i} ${h}`);
  }
  // A single trailing summary column, NOT the report-exporter's own name -
  // every login user who actually recorded one of THIS member's payments in
  // range (e.g. Bakkiya collected March, Kannan collected April both show
  // up here), derived the same way each group's own "Collected By" cell is.
  // A member with nothing paid in range (still fully pending) is blank here.
  headers.push('Processed By');

  const rows = [];
  for (const member of members) {
    const byMonth = paymentsByMemberMonth.get(member.id) || new Map();
    let totalExpected = 0;
    let totalPaid = 0;
    let totalPending = 0;
    const collectors = new Set();

    const monthGroupCells = [];
    for (const { key } of monthList) {
      const transactions = byMonth.get(key) || [];
      const { cells, paid, remaining } = monthCells(transactions, settings.monthlyFee);
      totalExpected += settings.monthlyFee;
      totalPaid += paid;
      totalPending += remaining;
      monthGroupCells.push(...cells);
      for (const t of transactions) {
        const collector = t.recordedByName || t.recordedByEmail;
        if (collector) collectors.add(collector);
      }
    }

    const relevantVisitors = relevantVisitorsByMember.get(member.id) || [];
    const visitorGroupCells = [];
    for (let i = 0; i < maxVisitors; i += 1) {
      const visitor = relevantVisitors[i];
      if (!visitor) {
        visitorGroupCells.push(...VISITOR_GROUP_HEADERS.map(() => ''));
        continue;
      }
      const { cells, paid, remaining } = visitorCells(visitor, settings.visitorFee);
      totalExpected += settings.visitorFee;
      totalPaid += paid;
      totalPending += remaining;
      visitorGroupCells.push(...cells);
      for (const t of visitor.payments || []) {
        const collector = t.recordedByName || t.recordedByEmail;
        if (collector) collectors.add(collector);
      }
    }

    rows.push([
      member.name,
      totalExpected,
      totalPaid,
      totalPending,
      statusOf(totalPaid, totalExpected),
      ...monthGroupCells,
      ...visitorGroupCells,
      joinUnique([...collectors]),
    ]);
  }

  return { headers, rows, monthGroupCount: monthList.length, visitorGroupCount: maxVisitors };
}

module.exports = { buildMemberExportSheet, MONTH_GROUP_HEADERS, VISITOR_GROUP_HEADERS };
