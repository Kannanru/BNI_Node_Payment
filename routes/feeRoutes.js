const express = require('express');
const { getFees, setFee, getFeeMonths, saveFeeMonths } = require('../controllers/feeController');

const router = express.Router();

// Month-wise fee schedule for member / visitor / guest fees. A saved month's
// fee is locked for good - there is deliberately no update or delete route.
router.get('/', getFees);
router.post('/', setFee);
router.get('/months', getFeeMonths); // ?role=member&year=2026 -> the 12 months
router.post('/months', saveFeeMonths); // { role, entries: [{ month, amount }] }

module.exports = router;
