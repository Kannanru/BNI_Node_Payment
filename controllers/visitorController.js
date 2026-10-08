const Visitor = require('../models/Visitor');
const { findMemberById } = require('../utils/membersData');
const { getOrCreateSettings } = require('../utils/getSettings');
const { buildVisitorStatus } = require('../utils/paymentCalculator');
const { validateMethodFields, attributionFrom, logVisitorPayment, parsePaidAt } = require('./paymentController');
const { actorFrom, diff, logAudit } = require('../utils/audit');
const { loadFeeResolver, currentFees } = require('../utils/feeSchedule');

function visitorDetails(visitor) {
  return {
    name: visitor.name,
    type: visitor.type || 'visitor',
    ...(visitor.phone ? { phone: visitor.phone } : {}),
    ...(visitor.email ? { email: visitor.email } : {}),
  };
}

async function createVisitor(req, res, next) {
  try {
    const { memberId, name, email, phone, type } = req.body;

    if (!memberId || !(await findMemberById(memberId))) {
      return res.status(400).json({ message: 'Unknown memberId' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }
    if (type !== undefined && type !== 'visitor' && type !== 'guest') {
      return res.status(400).json({ message: "type must be 'visitor' or 'guest'" });
    }
    // email/phone are optional and unvalidated by design - whatever's
    // provided (including nothing) is stored as-is.

    const resolvedType = type === 'guest' ? 'guest' : 'visitor';
    const settings = await getOrCreateSettings();
    // This month's visitor/guest fee from the fee schedule, fixed onto this
    // visitor's charge - a later fee change never alters it.
    const fee = currentFees(await loadFeeResolver(settings))[resolvedType];

    const visitor = await Visitor.create({
      memberId,
      name: name.trim(),
      type: resolvedType,
      email: (email || '').trim().toLowerCase(),
      phone: (phone || '').trim(),
      // This visitor's (or guest's) one and only charge, fixed at whatever
      // the applicable fee is right now - a later Settings change (see
      // settingsController.js#updateSettings) never alters this; it only
      // ever applies to one created after that change.
      charges: [{ amount: fee, effectiveFrom: new Date(), payments: [] }],
      createdBy: actorFrom(req),
    });

    await logAudit({
      action: 'visitor.create',
      entityType: 'visitor',
      entityId: visitor._id,
      memberId,
      details: { ...visitorDetails(visitor), fee },
      actor: actorFrom(req),
    });

    res.status(201).json({ visitor: buildVisitorStatus(visitor, fee) });
  } catch (err) {
    next(err);
  }
}


async function listVisitorsForMember(req, res, next) {
  try {
    const { memberId } = req.query;
    if (!memberId || !(await findMemberById(memberId))) {
      return res.status(400).json({ message: 'Unknown memberId' });
    }
    const settings = await getOrCreateSettings();
    const visitors = await Visitor.find({ memberId }).sort({ createdAt: -1 }).lean();
    res.json({ visitors: visitors.map((v) => buildVisitorStatus(v, settings.visitorFee)) });
  } catch (err) {
    next(err);
  }
}

// Records a new payment transaction against ONE specific charge - mirrors
// paymentController's recordPayment: always pushes a new transaction rather
// than overwriting, so a charge can be split across methods just like a
// month can. Deliberately scoped to [chargeId] only - it can never touch or
// be offset by any other charge on the same visitor (see Visitor.js's
// visitorChargeSchema), so paying the ₹100 due never affects a separate
// ₹200 due.
async function recordVisitorPayment(req, res, next) {
  try {
    const { visitorId, chargeId } = req.params;
    const { method, amount, cardLastFour, remarks, transactionRef } = req.body;

    const visitor = await Visitor.findById(visitorId);
    if (!visitor) {
      return res.status(404).json({ message: 'Visitor not found' });
    }
    const charge = visitor.charges.id(chargeId);
    if (!charge) {
      return res.status(404).json({ message: 'Charge not found' });
    }

    const methodError = validateMethodFields(method, cardLastFour);
    if (methodError) return res.status(400).json({ message: methodError });
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ message: 'amount must be a positive number' });
    }
    const { paidAt, error: paidAtError } = parsePaidAt(req.body.paidAt);
    if (paidAtError) return res.status(400).json({ message: paidAtError });

    charge.payments.push({
      method,
      amount,
      paidAt,
      ...(method === 'card' ? { cardLastFour } : {}),
      ...attributionFrom(req, { remarks, transactionRef }),
    });
    await visitor.save();
    await logVisitorPayment('visitor_payment.create', visitor, charge.payments[charge.payments.length - 1], actorFrom(req));

    const settings = await getOrCreateSettings();
    res.status(201).json({ visitor: buildVisitorStatus(visitor, settings.visitorFee) });
  } catch (err) {
    next(err);
  }
}

// Edits an existing payment transaction on ONE specific charge. A reason is
// mandatory, same as editPayment for month-based payments.
async function editVisitorPayment(req, res, next) {
  try {
    const { visitorId, chargeId, paymentId } = req.params;
    const { method, amount, cardLastFour, reason } = req.body;

    const visitor = await Visitor.findById(visitorId);
    if (!visitor) {
      return res.status(404).json({ message: 'Visitor not found' });
    }
    const charge = visitor.charges.id(chargeId);
    if (!charge) {
      return res.status(404).json({ message: 'Charge not found' });
    }
    const payment = charge.payments.id(paymentId);
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
    await visitor.save();

    await logVisitorPayment('visitor_payment.update', visitor, payment, actor, {
      reason: payment.editReason,
      changes: diff(before, payment.toObject(), ['amount', 'method', 'cardLastFour']),
    });

    const settings = await getOrCreateSettings();
    res.json({ visitor: buildVisitorStatus(visitor, settings.visitorFee) });
  } catch (err) {
    next(err);
  }
}

// Edits a visitor's (or guest's) own details - name/email/phone only.
// Deliberately never accepts `type` or touches `charges`: which fee applies
// is fixed forever at whatever it was when they were created (see
// createVisitor above), and changing type after the fact would leave that
// already-billed amount pointing at the wrong fee's history for no real
// benefit - if the wrong button was tapped, deleting and re-adding is the
// correct fix, not silently reinterpreting an existing charge.
async function updateVisitor(req, res, next) {
  try {
    const { visitorId } = req.params;
    const { name, email, phone } = req.body;

    const visitor = await Visitor.findById(visitorId);
    if (!visitor) {
      return res.status(404).json({ message: 'Visitor not found' });
    }

    const before = visitor.toObject();
    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ message: 'Name is required' });
      }
      visitor.name = name.trim();
    }
    if (email !== undefined) visitor.email = (email || '').trim().toLowerCase();
    if (phone !== undefined) visitor.phone = (phone || '').trim();
    await visitor.save();

    const changes = diff(before, visitor.toObject(), ['name', 'email', 'phone']);
    if (changes.length) {
      await logAudit({
        action: 'visitor.update',
        entityType: 'visitor',
        entityId: visitor._id,
        memberId: visitor.memberId,
        details: visitorDetails(visitor),
        changes,
        actor: actorFrom(req),
      });
    }

    const settings = await getOrCreateSettings();
    const fee = visitor.type === 'guest' ? settings.guestFee : settings.visitorFee;
    res.json({ visitor: buildVisitorStatus(visitor, fee) });
  } catch (err) {
    next(err);
  }
}

// Soft-deletes a visitor/guest: hidden from the app (and from every total and
// pending figure - see the query hook in models/Visitor.js), but the record
// and its full payment history stay in the database, and the deletion goes
// into the host member's history.
async function deleteVisitor(req, res, next) {
  try {
    const { visitorId } = req.params;
    const actor = actorFrom(req);
    const visitor = await Visitor.findOneAndUpdate(
      { _id: visitorId },
      { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: actor } },
      { new: true }
    );
    if (!visitor) {
      return res.status(404).json({ message: 'Visitor not found' });
    }

    const paid = visitor.charges.reduce((sum, c) => sum + c.payments.reduce((s, p) => s + p.amount, 0), 0);
    await logAudit({
      action: 'visitor.delete',
      entityType: 'visitor',
      entityId: visitor._id,
      memberId: visitor.memberId,
      details: { ...visitorDetails(visitor), totalPaid: paid },
      actor,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createVisitor,
  listVisitorsForMember,
  updateVisitor,
  recordVisitorPayment,
  editVisitorPayment,
  deleteVisitor,
};
