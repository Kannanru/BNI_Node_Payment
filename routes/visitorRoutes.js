const express = require('express');
const {
  createVisitor,
  listVisitorsForMember,
  recordVisitorPayment,
  editVisitorPayment,
  deleteVisitor,
} = require('../controllers/visitorController');

const router = express.Router();

router.post('/', createVisitor);
router.get('/', listVisitorsForMember);
// Every payment route is scoped to one specific charge (due record) - see
// visitorController.js's recordVisitorPayment/editVisitorPayment - so
// paying/editing one charge can never touch another on the same visitor.
router.post('/:visitorId/charges/:chargeId/payments', recordVisitorPayment);
router.patch('/:visitorId/charges/:chargeId/payments/:paymentId', editVisitorPayment);
router.delete('/:visitorId', deleteVisitor);

module.exports = router;
