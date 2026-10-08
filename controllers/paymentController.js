const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
const { findMemberById } = require('../utils/membersData');
const { getOrCreateSettings } = require('../utils/getSettings');
const mongoose = require('mongoose');
const { getPendingChargesForMonth, memberJoinMonthKey } = require('../utils/paymentCalculator');
const { buildMonthRange, monthKeyOf, parseMonthKey } = require('../utils/monthRange');
const { actorFrom, diff, logAudit } = require('../utils/audit');
const { loadFeeResolver } = require('../utils/feeSchedule');

const VALID_METHODS = ['upi', 'card', 'cash'];

// When the customer actually paid. The admin may enter a payment later than
// it happened, so the app can send the real date/time; when it doesn't, the
// payment is dated "now". Returns { paidAt } or { error }. A small allowance
// for clock differences between phone and server is accepted; anything
// further in the future, or more than 2 years back, is rejected.
function parsePaidAt(value) {
  if (value === undefined || value === null || value === '') return { paidAt: new Date() };
  const paidAt = new Date(value);
  if (Number.isNaN(paidAt.getTime())) return { error: 'paidAt must be a valid date/time' };
  const now = Date.now();
  if (paidAt.getTime() > now + 5 * 60 * 1000) return { error: 'Payment date & time cannot be in the future' };
  if (paidAt.getTime() < now - 2 * 365 * 24 * 60 * 60 * 1000) return { error: 'Payment date is too far in the past' };
  return { paidAt: paidAt.getTime() > now ? new Date(now) : paidAt };
}

// Who recorded a transaction (stamped on it at creation and never changed by
// an edit), plus the optional note/reference the recorder typed in.
function attributionFrom(req, { remarks, transactionRef } = {}) {
  return {
    ...(req.user?.name ? { recordedByName: req.user.name } : {}),
    ...(req.user?.email ? { recordedByEmail: req.user.email } : {}),
    ...(req.user?.id ? { recordedById: String(req.user.id) } : {}),
    ...(req.user?.phone ? { recordedByPhone: req.user.phone } : {}),
    ...(remarks ? { remarks: String(remarks).trim() } : {}),
    ...(transactionRef ? { transactionRef: String(transactionRef).trim() } : {}),
  };
}

function logPaymentCreated(payment, actor, extra = {}) {
  return logAudit({
    action: 'payment.create',
    entityType: 'payment',
    entityId: payment._id,
    memberId: payment.memberId,
    details: {
      ...extra,
      month: payment.month,
      amount: payment.amount,
      method: payment.method,
      paidAt: payment.paidAt,
      enteredAt: payment.createdAt || new Date(),
      ...(payment.cardLastFour ? { cardLastFour: payment.cardLastFour } : {}),
      ...(payment.transactionRef ? { transactionRef: payment.transactionRef } : {}),
      ...(payment.remarks ? { remarks: payment.remarks } : {}),
    },
    actor,
    at: payment.paidAt,
  });
}

// One visitor/guest fee transaction - filed under the visitor's host member.
function logVisitorPayment(action, visitor, payment, actor, extra = {}) {
  return logAudit({
    action,
    entityType: 'visitor_payment',
    entityId: payment._id,
    memberId: visitor.memberId,
    details: {
      visitorId: String(visitor._id),
      visitorName: visitor.name,
      visitorType: visitor.type || 'visitor',
      amount: payment.amount,
      method: payment.method,
      paidAt: payment.paidAt,
      enteredAt: payment.createdAt || new Date(),
      ...(payment.cardLastFour ? { cardLastFour: payment.cardLastFour } : {}),
      ...extra,
    },
    changes: extra.changes || [],
    actor,
    // A new payment is filed at the time it was actually paid; an edit at
    // the time it was made.
    ...(action === 'visitor_payment.create' ? { at: payment.paidAt } : {}),
  });
}

function validateMethodFields(method, cardLastFour) {
  if (!VALID_METHODS.includes(method)) {
    return `method must be one of ${VALID_METHODS.join(', ')}`;
  }
  if (method === 'card' && !/^\d{4}$/.test(cardLastFour || '')) {
    return 'cardLastFour must be exactly 4 digits when method is card';
  }
  return null;
}

// Records a new payment transaction for a member/month. Multiple
// transactions (even with different methods) can exist for the same month -
// e.g. 2,000 via Cash and 3,000 via UPI both count toward April - so this
// always inserts rather than upserting a single row.
//
// If the member has any pending visitor charge(s) incurred during that same
// month, the paid amount is automatically applied to the membership fee
// FIRST, and whatever's left over spills into those visitor charges (oldest
// first, each filled in full before moving to the next - see
// getPendingChargesForMonth) - so admins can pay a member's combined
// "month + visitor" total in one go instead of two separate flows.
// Everything is recomputed fresh from the DB on every call (not just
// trusted from the request), so a payment split across several methods -
// which the mobile app sends as one recordPayment call per method, awaited
// in sequence - still allocates correctly call-by-call. When there are no
// pending visitor charges for the month, behaviour is byte-for-byte
// identical to before this feature existed.
async function recordPayment(req, res, next) {
  try {
    const { memberId, month, method, amount, cardLastFour, remarks, transactionRef } = req.body;
    const { paidAt, error: paidAtError } = parsePaidAt(req.body.paidAt);
    if (paidAtError) return res.status(400).json({ message: paidAtError });

    if (!memberId || !(await findMemberById(memberId))) {
      return res.status(400).json({ message: 'Unknown memberId' });
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) {
      return res.status(400).json({ message: 'month must be in YYYY-MM format' });
    }
    const methodError = validateMethodFields(method, cardLastFour);
    if (methodError) return res.status(400).json({ message: methodError });
    if (amount !== undefined && (typeof amount !== 'number' || amount < 0)) {
      return res.status(400).json({ message: 'amount must be a non-negative number' });
    }

    const settings = await getOrCreateSettings();
    // The fee for THIS month (not today's fee) - see utils/feeSchedule.js.
    const monthFee = (await loadFeeResolver(settings))('member', month);
    const paidAmount = amount !== undefined ? amount : monthFee;
    const cardFields = method === 'card' ? { cardLastFour } : {};
    // Stamped on every new transaction created below (both the month's own
    // Payment doc and any visitor-spillover subdocs), so the export report's
    // "Collected By"/"Remarks"/"Transaction Reference" columns can be filled
    // in for payments recorded from here on. req.user.name is only present
    // on tokens issued after this field was added - see authMiddleware.
    const actor = actorFrom(req);
    const attributionFields = attributionFrom(req, { remarks, transactionRef });

    const [monthPayments, memberVisitors] = await Promise.all([
      Payment.find({ memberId, month }).lean(),
      Visitor.find({ memberId }).lean(),
    ]);
    const monthPaid = monthPayments.reduce((sum, p) => sum + p.amount, 0);
    const monthRemaining = Math.max(monthFee - monthPaid, 0);
    const pendingCharges = getPendingChargesForMonth(
      memberVisitors,
      month,
      settings.visitorFee,
      settings.visitorPaymentStartDate
    );

    if (pendingCharges.length === 0) {
      // Unchanged fast path - no visitor charges to fold in this month.
      const payment = await Payment.create({
        memberId,
        month,
        method,
        amount: paidAmount,
        paidAt,
        ...cardFields,
        ...attributionFields,
      });
      await logPaymentCreated(payment, actor);
      return res.status(201).json({ payment });
    }

    let toAllocate = paidAmount;
    const monthPortion = Math.min(toAllocate, monthRemaining);
    toAllocate -= monthPortion;

    let payment =
      monthPortion > 0
        ? await Payment.create({
            memberId,
            month,
            method,
            amount: monthPortion,
            paidAt,
            ...cardFields,
            ...attributionFields,
          })
        : null;

    for (const charge of pendingCharges) {
      if (toAllocate <= 0) break;
      const portion = Math.min(toAllocate, charge.remaining);
      if (portion <= 0) continue;
      const updatedVisitor = await Visitor.findOneAndUpdate(
        { _id: charge.visitorId, 'charges._id': charge.chargeId },
        {
          $push: {
            'charges.$.payments': { method, amount: portion, paidAt, ...cardFields, ...attributionFields },
          },
        },
        { new: true }
      );
      if (updatedVisitor) {
        const updatedCharge = updatedVisitor.charges.id(charge.chargeId);
        const added = updatedCharge.payments[updatedCharge.payments.length - 1];
        await logVisitorPayment('visitor_payment.create', updatedVisitor, added, actor, {
          note: `Part of the ${month} membership payment`,
        });
      }
      toAllocate -= portion;
    }

    if (toAllocate > 0) {
      // Leftover after the month and every one of its pending visitors are
      // fully covered (a manual overpayment) - same "don't reject, let it
      // overpay" behaviour the month-only path already had.
      if (payment) {
        payment.amount += toAllocate;
        await payment.save();
      } else {
        payment = await Payment.create({
          memberId,
          month,
          method,
          amount: toAllocate,
          paidAt,
          ...cardFields,
          ...attributionFields,
        });
      }
    }

    if (payment) await logPaymentCreated(payment, actor);
    res.status(201).json({ payment });
  } catch (err) {
    next(err);
  }
}

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_ADVANCE_MONTHS = 12;
const round2 = (n) => Math.round(n * 100) / 100;

// The months a payment may be applied to for this member, oldest first, each
// with its own fee and what is still owed on it: every tracked month from the
// later of the tracking start and the member's joining month up to this month,
// then up to MAX_ADVANCE_MONTHS future months (for advance payments).
async function memberMonthLedger(member, settings, resolveFee) {
  const now = new Date();
  const nowMonth = monthKeyOf(now.getFullYear(), now.getMonth() + 1);
  let startKey = settings.columnDisplayStartMonth || settings.defaultStartMonth;
  const joinKey = memberJoinMonthKey(member);
  if (joinKey && joinKey > startKey) startKey = joinKey;

  const keys = buildMonthRange(startKey, now).map((m) => m.key);
  let { year, month } = parseMonthKey(nowMonth);
  for (let i = 0; i < MAX_ADVANCE_MONTHS; i++) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    keys.push(monthKeyOf(year, month));
  }

  const payments = await Payment.find({ memberId: member.id, month: { $in: keys } }).select('month amount').lean();
  const paidByMonth = new Map();
  for (const p of payments) paidByMonth.set(p.month, (paidByMonth.get(p.month) || 0) + p.amount);

  return keys.map((key) => {
    const fee = resolveFee('member', key);
    const paid = paidByMonth.get(key) || 0;
    return { month: key, fee, paid, outstanding: round2(Math.max(fee - paid, 0)), isAdvance: key > nowMonth };
  });
}

// Records ONE payment received from a member and spreads it across one or
// more months. Without `allocations`, it fills the oldest month still owed
// first, then the next, and so on; anything beyond everything owed so far
// becomes an advance for the coming month(s). With `allocations`
// ([{ month, amount }]) the admin decides the split - it must add up to the
// amount and can't put more on a month than that month still owes.
//
// Each month's share is stored as its own Payment document (so every
// month-based total, sheet and report works exactly as before), all sharing a
// receiptId so the payment is still shown as the single payment it was.
async function recordAllocatedPayment(req, res, next) {
  try {
    const { memberId, method, cardLastFour, remarks, transactionRef } = req.body;
    const amount = req.body.amount;

    const member = memberId ? await findMemberById(memberId) : null;
    if (!member) return res.status(400).json({ message: 'Unknown memberId' });
    const methodError = validateMethodFields(method, cardLastFour);
    if (methodError) return res.status(400).json({ message: methodError });
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'amount must be a positive number' });
    }
    const { paidAt, error: paidAtError } = parsePaidAt(req.body.paidAt);
    if (paidAtError) return res.status(400).json({ message: paidAtError });

    const settings = await getOrCreateSettings();
    const resolveFee = await loadFeeResolver(settings);
    const ledger = await memberMonthLedger(member, settings, resolveFee);
    const byMonth = new Map(ledger.map((l) => [l.month, l]));

    let allocations;
    if (Array.isArray(req.body.allocations) && req.body.allocations.length) {
      allocations = [];
      const seen = new Set();
      for (const a of req.body.allocations) {
        const month = a && a.month;
        const share = a && a.amount;
        if (!MONTH_REGEX.test(month || '')) return res.status(400).json({ message: 'Each allocation needs a month in YYYY-MM format' });
        if (seen.has(month)) return res.status(400).json({ message: `${month} appears more than once` });
        seen.add(month);
        if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0) {
          return res.status(400).json({ message: `Allocation for ${month} must be a positive amount` });
        }
        const entry = byMonth.get(month);
        if (!entry) return res.status(400).json({ message: `${month} can't be paid for this member` });
        if (share > entry.outstanding + 0.001) {
          return res.status(400).json({ message: `${month} only has ₹${entry.outstanding} left to pay` });
        }
        allocations.push({ month, amount: round2(share), isAdvance: entry.isAdvance });
      }
      allocations.sort((x, y) => (x.month < y.month ? -1 : 1));
      const total = round2(allocations.reduce((s, a) => s + a.amount, 0));
      if (Math.abs(total - amount) > 0.001) {
        return res.status(400).json({ message: `Allocations add up to ₹${total}, but the payment is ₹${amount}` });
      }
    } else {
      // Oldest first: months owed up to now, then advance months.
      allocations = [];
      let left = round2(amount);
      for (const entry of ledger) {
        if (left <= 0) break;
        const share = round2(Math.min(left, entry.outstanding));
        if (share <= 0) continue;
        allocations.push({ month: entry.month, amount: share, isAdvance: entry.isAdvance });
        left = round2(left - share);
      }
      if (left > 0) {
        return res.status(400).json({
          message: `₹${amount} is more than everything owed plus ${MAX_ADVANCE_MONTHS} months in advance - please check the amount.`,
        });
      }
    }

    const receiptId = new mongoose.Types.ObjectId().toString();
    const actor = actorFrom(req);
    const cardFields = method === 'card' ? { cardLastFour } : {};
    const attributionFields = attributionFrom(req, { remarks, transactionRef });
    const receiptSummary = allocations.map((a) => ({ month: a.month, amount: a.amount }));

    const payments = [];
    for (const a of allocations) {
      const payment = await Payment.create({
        memberId: member.id,
        month: a.month,
        method,
        amount: a.amount,
        paidAt,
        receiptId,
        ...cardFields,
        ...attributionFields,
      });
      payments.push(payment);
      await logPaymentCreated(payment, actor, {
        receiptId,
        receiptTotal: round2(amount),
        receiptAllocations: receiptSummary,
        ...(a.isAdvance ? { isAdvance: true } : {}),
      });
    }

    res.status(201).json({ receiptId, amount: round2(amount), allocations, payments });
  } catch (err) {
    next(err);
  }
}

// Edits an existing payment transaction. A reason is mandatory and is stored
// on the transaction alongside the change, so there's always a record of why
// a previously-saved payment was modified.
async function editPayment(req, res, next) {
  try {
    const { paymentId } = req.params;
    const { method, amount, cardLastFour, reason } = req.body;

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    const methodError = validateMethodFields(method, cardLastFour);
    if (methodError) return res.status(400).json({ message: methodError });
    if (typeof amount !== 'number' || amount < 0) {
      return res.status(400).json({ message: 'amount must be a non-negative number' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ message: 'A reason is required to edit a payment' });
    }

    const before = payment.toObject();
    const actor = actorFrom(req);
    payment.method = method;
    payment.amount = amount;
    payment.cardLastFour = method === 'card' ? cardLastFour : undefined;
    payment.editReason = String(reason).trim();
    payment.lastEditedAt = new Date();
    payment.lastEditedByName = actor?.name;
    await payment.save();

    // Every edit keeps its old -> new values in the history, so nothing about
    // the original payment is lost even though the record itself is updated.
    await logAudit({
      action: 'payment.update',
      entityType: 'payment',
      entityId: payment._id,
      memberId: payment.memberId,
      details: { month: payment.month, amount: payment.amount, method: payment.method, reason: payment.editReason },
      changes: diff(before, payment.toObject(), ['amount', 'method', 'cardLastFour']),
      actor,
    });

    res.json({ payment });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  recordPayment,
  recordAllocatedPayment,
  editPayment,
  validateMethodFields,
  attributionFrom,
  logVisitorPayment,
  parsePaidAt,
};
