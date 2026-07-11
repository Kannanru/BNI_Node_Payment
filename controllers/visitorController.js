const Visitor = require('../models/Visitor');
const { findMemberById } = require('../utils/membersData');
const { getOrCreateSettings } = require('../utils/getSettings');
const { buildVisitorStatus } = require('../utils/paymentCalculator');
const { validateMethodFields } = require('./paymentController');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?[0-9\s-]{7,15}$/;

async function createVisitor(req, res, next) {
  try {
    const { memberId, name, email, phone } = req.body;

    if (!memberId || !findMemberById(memberId)) {
      return res.status(400).json({ message: 'Unknown memberId' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Visitor name is required' });
    }
    if (!EMAIL_REGEX.test(email || '')) {
      return res.status(400).json({ message: 'A valid email is required' });
    }
    if (!PHONE_REGEX.test(phone || '')) {
      return res.status(400).json({ message: 'A valid phone number is required' });
    }

    const settings = await getOrCreateSettings();

    const visitor = await Visitor.create({
      memberId,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone.trim(),
    });

    res.status(201).json({ visitor: buildVisitorStatus(visitor, settings.visitorFee) });
  } catch (err) {
    next(err);
  }
}

async function listVisitorsForMember(req, res, next) {
  try {
    const { memberId } = req.query;
    if (!memberId || !findMemberById(memberId)) {
      return res.status(400).json({ message: 'Unknown memberId' });
    }
    const settings = await getOrCreateSettings();
    const visitors = await Visitor.find({ memberId }).sort({ createdAt: -1 }).lean();
    res.json({ visitors: visitors.map((v) => buildVisitorStatus(v, settings.visitorFee)) });
  } catch (err) {
    next(err);
  }
}

// Records a new visitor-fee payment transaction. Mirrors paymentController's
// recordPayment: always pushes a new transaction rather than overwriting, so
// a visitor fee can be split across methods just like a month can.
async function recordVisitorPayment(req, res, next) {
  try {
    const { visitorId } = req.params;
    const { method, amount, cardLastFour, remarks, transactionRef } = req.body;

    const visitor = await Visitor.findById(visitorId);
    if (!visitor) {
      return res.status(404).json({ message: 'Visitor not found' });
    }

    const methodError = validateMethodFields(method, cardLastFour);
    if (methodError) return res.status(400).json({ message: methodError });
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ message: 'amount must be a positive number' });
    }

    visitor.payments.push({
      method,
      amount,
      paidAt: new Date(),
      ...(method === 'card' ? { cardLastFour } : {}),
      ...(req.user?.name ? { recordedByName: req.user.name } : {}),
      ...(req.user?.email ? { recordedByEmail: req.user.email } : {}),
      ...(remarks ? { remarks: String(remarks).trim() } : {}),
      ...(transactionRef ? { transactionRef: String(transactionRef).trim() } : {}),
    });
    await visitor.save();

    const settings = await getOrCreateSettings();
    res.status(201).json({ visitor: buildVisitorStatus(visitor, settings.visitorFee) });
  } catch (err) {
    next(err);
  }
}

// Edits an existing visitor-fee payment transaction. A reason is mandatory,
// same as editPayment for month-based payments.
async function editVisitorPayment(req, res, next) {
  try {
    const { visitorId, paymentId } = req.params;
    const { method, amount, cardLastFour, reason } = req.body;

    const visitor = await Visitor.findById(visitorId);
    if (!visitor) {
      return res.status(404).json({ message: 'Visitor not found' });
    }
    const payment = visitor.payments.id(paymentId);
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

    payment.method = method;
    payment.amount = amount;
    payment.cardLastFour = method === 'card' ? cardLastFour : undefined;
    payment.editReason = String(reason).trim();
    await visitor.save();

    const settings = await getOrCreateSettings();
    res.json({ visitor: buildVisitorStatus(visitor, settings.visitorFee) });
  } catch (err) {
    next(err);
  }
}

// Permanently removes a visitor and every payment transaction recorded
// against their fee - there's nothing else referencing a visitor by id
// (Payment documents are membership-fee only), so this is a clean delete
// with no other records left dangling.
async function deleteVisitor(req, res, next) {
  try {
    const { visitorId } = req.params;
    const visitor = await Visitor.findByIdAndDelete(visitorId);
    if (!visitor) {
      return res.status(404).json({ message: 'Visitor not found' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createVisitor,
  listVisitorsForMember,
  recordVisitorPayment,
  editVisitorPayment,
  deleteVisitor,
};
