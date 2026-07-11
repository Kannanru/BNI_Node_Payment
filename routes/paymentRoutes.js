const express = require('express');
const { recordPayment, editPayment } = require('../controllers/paymentController');

const router = express.Router();

router.post('/', recordPayment);
router.patch('/:paymentId', editPayment);

module.exports = router;
