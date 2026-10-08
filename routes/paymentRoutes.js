const express = require('express');
const { recordPayment, recordAllocatedPayment, editPayment } = require('../controllers/paymentController');

const router = express.Router();

router.post('/', recordPayment);
// One payment spread over several months (oldest first, or as allocated).
router.post('/allocate', recordAllocatedPayment);
router.patch('/:paymentId', editPayment);

module.exports = router;
