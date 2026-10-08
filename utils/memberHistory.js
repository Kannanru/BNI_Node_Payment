const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
const AuditLog = require('../models/AuditLog');
const { findMemberById } = require('./membersData');
const { buildMonthRange, parseMonthKey, monthKeyOf, MONTH_LABELS } = require('./monthRange');
const { isVisitorInScope } = require('./paymentCalculator');
const { loadFeeResolver, currentFees, currentMonthKey } = require('./feeSchedule');

const METHOD_LABELS = { upi: 'UPI', card: 'Card', cash: 'Cash' };
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

function money(amount) {
  return inr.format(Number(amount) || 0);
}

function monthLabel(monthKey) {
  if (!monthKey) return '';
  const { year, month } = parseMonthKey(monthKey);
  return `${MONTH_LABELS[month - 1]} ${year}`;
}

function methodLabel(method, cardLastFour) {
  const label = METHOD_LABELS[method] || method || '';
  return method === 'card' && cardLastFour ? `${label} ••${cardLastFour}` : label;
}

function kindLabel(type) {
  return type === 'guest' ? 'Guest' : 'Visitor';
}

// Field names as an admin would say them, for "old -> new" lines.
const FIELD_LABELS = {
  name: 'Name',
  phone: 'Phone',
  email: 'Email',
  amount: 'Amount',
  method: 'Payment method',
  cardLastFour: 'Card last 4 digits',
};

function formatChangeValue(field, value) {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (field === 'amount') return money(value);
  if (field === 'method') return METHOD_LABELS[value] || value;
  return String(value);
}

function formatChanges(changes = []) {
  return changes.map((c) => ({
    field: c.field,
    label: FIELD_LABELS[c.field] || c.field,
    from: formatChangeValue(c.field, c.from),
    to: formatChangeValue(c.field, c.to),
  }));
}

// One recorded history event -> what the timeline shows.
function describeLog(log) {
  const d = log.details || {};
  switch (log.action) {
    case 'member.create':
      return { title: 'Member created', description: d.phone ? `${d.name} · +91 ${d.phone}` : d.name, icon: 'member_add' };
    case 'member.update':
      return { title: 'Member details updated', description: null, icon: 'edit' };
    case 'member.delete':
      return { title: 'Member deleted', description: 'Removed from the app. All records are kept.', icon: 'delete' };
    case 'payment.create':
      return {
        title: `${d.isAdvance ? 'Advance payment' : 'Payment received'} · ${monthLabel(d.month)}`,
        description: `${money(d.amount)} via ${methodLabel(d.method, d.cardLastFour)}`
          + (d.receiptTotal && Array.isArray(d.receiptAllocations) && d.receiptAllocations.length > 1
            ? ` · part of one ${money(d.receiptTotal)} payment (${d.receiptAllocations
              .map((a) => `${monthLabel(a.month)} ${money(a.amount)}`)
              .join(' · ')})`
            : '')
          + (d.transactionRef ? ` · Ref ${d.transactionRef}` : '')
          + (d.remarks ? ` · ${d.remarks}` : ''),
        icon: 'payment',
        amount: d.amount,
        method: d.method,
        month: d.month,
      };
    case 'payment.delete':
      return {
        title: `Payment removed · ${monthLabel(d.month)}`,
        description: `${money(d.amount)} via ${methodLabel(d.method, d.cardLastFour)}${d.reason ? ` · ${d.reason}` : ''}`,
        icon: 'delete',
        month: d.month,
      };
    case 'payment.update':
      return {
        title: `Payment edited · ${monthLabel(d.month)}`,
        description: d.reason ? `Reason: ${d.reason}` : null,
        icon: 'payment_edit',
        month: d.month,
      };
    case 'visitor.create':
      return {
        title: `${kindLabel(d.type)} added · ${d.name}`,
        description: d.fee !== undefined ? `Fee ${money(d.fee)}` : null,
        icon: 'visitor_add',
      };
    case 'visitor.update':
      return { title: `${kindLabel(d.type)} details updated · ${d.name}`, description: null, icon: 'edit' };
    case 'visitor.delete':
      return {
        title: `${kindLabel(d.type)} deleted · ${d.name}`,
        description: `Removed from the app. Paid so far: ${money(d.totalPaid)}. Records are kept.`,
        icon: 'delete',
      };
    case 'visitor_payment.create':
      return {
        title: `${kindLabel(d.visitorType)} fee received · ${d.visitorName}`,
        description: `${money(d.amount)} via ${methodLabel(d.method, d.cardLastFour)}` + (d.note ? ` · ${d.note}` : ''),
        icon: 'payment',
        amount: d.amount,
        method: d.method,
      };
    case 'visitor_payment.update':
      return {
        title: `${kindLabel(d.visitorType)} fee payment edited · ${d.visitorName}`,
        description: d.reason ? `Reason: ${d.reason}` : null,
        icon: 'payment_edit',
      };
    default:
      return { title: log.action, description: null, icon: 'info' };
  }
}

function event({ id, at, action, actorName, legacy = false, changes = [], ...rest }) {
  return { id: String(id), at, action, actorName: actorName || null, legacy, changes, ...rest };
}

// Every month from the start month through this month, each with what's
// been paid and what's still owed. Starts at the same month the Home
// screen's month columns start from (Settings.columnDisplayStartMonth), so
// the history never lists months the app itself doesn't track. A member
// created in the app (not imported) only owes from the month they joined.
// Each month is measured against the fee that applied to THAT month.
function buildMonthStatuses(member, payments, settings, resolveFee) {
  let startKey = settings.columnDisplayStartMonth || settings.defaultStartMonth;
  if (!member.importedFromFile && member.createdAt) {
    const created = new Date(member.createdAt);
    const joinKey = monthKeyOf(created.getFullYear(), created.getMonth() + 1);
    if (joinKey > startKey) startKey = joinKey;
  }

  const paidByMonth = new Map();
  for (const p of payments) paidByMonth.set(p.month, (paidByMonth.get(p.month) || 0) + p.amount);

  return buildMonthRange(startKey).map(({ key }) => {
    const paid = paidByMonth.get(key) || 0;
    const fee = resolveFee('member', key);
    const remaining = Math.max(fee - paid, 0);
    return {
      monthKey: key,
      label: monthLabel(key),
      totalDue: fee,
      paid,
      remaining,
      status: remaining <= 0 ? 'paid' : paid > 0 ? 'partial' : 'pending',
    };
  });
}

// Builds the complete history for one member: details, every payment, every
// pending month/visitor charge, and a newest-first timeline of every event.
// Events recorded before history tracking existed are reconstructed from the
// records themselves and flagged legacy: true.
async function buildMemberTimeline(memberId, settings) {
  const member = await findMemberById(memberId, { includeDeleted: true });
  if (!member) return null;

  const [payments, visitors, logs, resolveFee] = await Promise.all([
    Payment.find({ memberId }).sort({ paidAt: -1 }).lean(),
    Visitor.find({ memberId }).setOptions({ withDeleted: true }).sort({ createdAt: -1 }).lean(),
    AuditLog.find({ memberId }).sort({ at: -1 }).lean(),
    loadFeeResolver(settings),
  ]);

  const logged = new Set(logs.map((l) => `${l.action}|${l.entityId}`));
  const events = logs.map((log) => {
    const described = describeLog(log);
    return event({
      id: log._id,
      at: log.at,
      action: log.action,
      actorName: log.actor?.name,
      changes: formatChanges(log.changes),
      // For payments: when the customer paid vs when it was entered in the app.
      paidAt: log.details?.paidAt || null,
      enteredAt: log.details?.enteredAt || null,
      ...described,
    });
  });

  // ---- Reconstructed events for records older than history tracking ----
  const earliestKnown = [
    member.createdAt,
    ...payments.map((p) => p.paidAt),
    ...visitors.map((v) => v.createdAt),
  ]
    .filter(Boolean)
    .reduce((min, d) => (new Date(d) < new Date(min) ? d : min), member.createdAt || new Date());

  if (!logged.has(`member.create|${memberId}`)) {
    events.push(event({
      id: `legacy-member-${memberId}`,
      at: earliestKnown,
      action: 'member.create',
      legacy: true,
      title: 'Member record',
      description: 'Added before history tracking started - creator and exact date were not recorded.',
      icon: 'member_add',
    }));
  }

  for (const p of payments) {
    if (!logged.has(`payment.create|${p._id}`)) {
      events.push(event({
        id: `legacy-payment-${p._id}`,
        at: p.paidAt,
        action: 'payment.create',
        actorName: p.recordedByName,
        legacy: true,
        title: `Payment received · ${monthLabel(p.month)}`,
        description: `${money(p.amount)} via ${methodLabel(p.method, p.cardLastFour)}`,
        icon: 'payment',
        amount: p.amount,
        method: p.method,
        month: p.month,
      }));
    }
    if (p.editReason && !logged.has(`payment.update|${p._id}`)) {
      events.push(event({
        id: `legacy-payment-edit-${p._id}`,
        at: p.updatedAt || p.paidAt,
        action: 'payment.update',
        legacy: true,
        title: `Payment edited · ${monthLabel(p.month)}`,
        description: `Reason: ${p.editReason} (old values were not recorded before history tracking)`,
        icon: 'payment_edit',
        month: p.month,
      }));
    }
  }

  for (const v of visitors) {
    if (!logged.has(`visitor.create|${v._id}`)) {
      events.push(event({
        id: `legacy-visitor-${v._id}`,
        at: v.createdAt,
        action: 'visitor.create',
        legacy: true,
        title: `${kindLabel(v.type)} added · ${v.name}`,
        description: v.charges?.[0] ? `Fee ${money(v.charges[0].amount)}` : null,
        icon: 'visitor_add',
      }));
    }
    for (const c of v.charges || []) {
      for (const vp of c.payments || []) {
        if (!logged.has(`visitor_payment.create|${vp._id}`)) {
          events.push(event({
            id: `legacy-vpayment-${vp._id}`,
            at: vp.paidAt,
            action: 'visitor_payment.create',
            actorName: vp.recordedByName,
            legacy: true,
            title: `${kindLabel(v.type)} fee received · ${v.name}`,
            description: `${money(vp.amount)} via ${methodLabel(vp.method, vp.cardLastFour)}`,
            icon: 'payment',
            amount: vp.amount,
            method: vp.method,
          }));
        }
      }
    }
  }

  events.sort((a, b) => new Date(b.at) - new Date(a.at));

  // ---- Payments (membership + visitor/guest fees), newest first ----
  const paymentRows = [
    ...payments.map((p) => ({
      id: String(p._id),
      kind: 'membership',
      month: p.month,
      monthLabel: monthLabel(p.month),
      amount: p.amount,
      method: p.method,
      methodLabel: methodLabel(p.method, p.cardLastFour),
      paidAt: p.paidAt,
      enteredAt: p.createdAt || null,
      receiptId: p.receiptId || null,
      isAdvance: p.month > currentMonthKey(),
      recordedByName: p.recordedByName || null,
      transactionRef: p.transactionRef || null,
      remarks: p.remarks || null,
      editReason: p.editReason || null,
      lastEditedAt: p.lastEditedAt || null,
      lastEditedByName: p.lastEditedByName || null,
    })),
    ...visitors.flatMap((v) =>
      (v.charges || []).flatMap((c) =>
        (c.payments || []).map((vp) => ({
          id: String(vp._id),
          kind: v.type === 'guest' ? 'guest' : 'visitor',
          visitorName: v.name,
          visitorDeleted: Boolean(v.isDeleted),
          month: null,
          monthLabel: null,
          amount: vp.amount,
          method: vp.method,
          methodLabel: methodLabel(vp.method, vp.cardLastFour),
          paidAt: vp.paidAt,
          enteredAt: vp.createdAt || null,
          recordedByName: vp.recordedByName || null,
          transactionRef: vp.transactionRef || null,
          remarks: vp.remarks || null,
          editReason: vp.editReason || null,
          lastEditedAt: vp.lastEditedAt || null,
          lastEditedByName: vp.lastEditedByName || null,
        }))
      )
    ),
  ].sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));

  // ---- Pending ----
  const months = buildMonthStatuses(member, payments, settings, resolveFee);
  const pendingMonths = months.filter((m) => m.remaining > 0);
  const pendingVisitors = visitors
    .filter((v) => !v.isDeleted && isVisitorInScope(v, settings.visitorPaymentStartDate))
    .map((v) => {
      const due = (v.charges || []).reduce((s, c) => s + c.amount, 0);
      const paid = (v.charges || []).reduce((s, c) => s + (c.payments || []).reduce((t, p) => t + p.amount, 0), 0);
      return { id: String(v._id), name: v.name, type: v.type || 'visitor', due, paid, remaining: Math.max(due - paid, 0) };
    })
    .filter((v) => v.remaining > 0);

  const sum = (list, key) => list.reduce((s, x) => s + (x[key] || 0), 0);

  return {
    member: {
      id: member.id,
      name: member.name,
      phone: member.phone || null,
      createdAt: member.importedFromFile ? null : member.createdAt,
      createdByName: member.createdBy?.name || null,
      importedFromFile: member.importedFromFile,
      isDeleted: member.isDeleted,
      deletedAt: member.deletedAt,
      deletedByName: member.deletedBy?.name || null,
    },
    summary: {
      monthlyFee: currentFees(resolveFee).member, // this month's fee
      trackedFrom: months.length ? months[0].monthKey : null,
      monthsPaid: months.filter((m) => m.status === 'paid').length,
      monthsPending: pendingMonths.length,
      totalPaidMembership: sum(payments, 'amount'),
      totalPaidVisitors: sum(paymentRows.filter((p) => p.kind !== 'membership'), 'amount'),
      pendingMonthsTotal: sum(pendingMonths, 'remaining'),
      pendingVisitorsTotal: sum(pendingVisitors, 'remaining'),
    },
    months,
    pendingMonths,
    pendingVisitors,
    payments: paymentRows,
    timeline: events,
  };
}

module.exports = { buildMemberTimeline };
