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
router.post('/:visitorId/payments', recordVisitorPayment);
router.patch('/:visitorId/payments/:paymentId', editVisitorPayment);
router.delete('/:visitorId', deleteVisitor);

module.exports = router;
