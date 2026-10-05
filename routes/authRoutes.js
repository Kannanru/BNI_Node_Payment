const express = require('express');
const { requestOtp, verifyOtp } = require('../controllers/authController');

const router = express.Router();

// Mobile number + SMS OTP login (see controllers/authController.js).
router.post('/request-otp', requestOtp);
router.post('/verify-otp', verifyOtp);

module.exports = router;
