const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
const { findMemberById } = require('../utils/membersData');
const { getOrCreateSettings } = require('../utils/getSettings');
const { getPendingChargesForMonth } = require('../utils/paymentCalculator');
const { actorFrom, diff, logAudit } = require('../utils/audit');

const VALID_METHODS = ['upi', 'card', 'cash'];

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

function logPaymentCreated(payment, actor) {
  return logAudit({
    action: 'payment.create',
    entityType: 'payment',
    entityId: payment._id,
    memberId: payment.memberId,
    details: {
      month: payment.month,
      amount: payment.amount,
      method: payment.method,
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
      ...(payment.cardLastFour ? { cardLastFour: payment.cardLastFour } : {}),
      ...extra,
    },
    changes: extra.changes || [],
    actor,
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
    const paidAmount = amount !== undefined ? amount : settings.monthlyFee;
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
    const monthRemaining = Math.max(settings.monthlyFee - monthPaid, 0);
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
        paidAt: new Date(),
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
            paidAt: new Date(),
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
            'charges.$.payments': { method, amount: portion, paidAt: new Date(), ...cardFields, ...attributionFields },
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
          paidAt: new Date(),
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

module.exports = { recordPayment, editPayment, validateMethodFields, attributionFrom, logVisitorPayment };
