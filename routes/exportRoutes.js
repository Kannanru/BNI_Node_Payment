const express = require('express');
const { exportReport } = require('../controllers/exportController');

const router = express.Router();

router.get('/', exportReport);

module.exports = router;
