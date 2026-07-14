const express = require('express');
const { exportReport, exportTransactionsByDate } = require('../controllers/exportController');

const router = express.Router();

router.get('/', exportReport);
router.get('/by-date', exportTransactionsByDate);

module.exports = router;
