const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');

const authRoutes = require('./authRoutes');
const memberRoutes = require('./memberRoutes');
const paymentRoutes = require('./paymentRoutes');
const visitorRoutes = require('./visitorRoutes');
const settingsRoutes = require('./settingsRoutes');
const exportRoutes = require('./exportRoutes');

const router = express.Router();

router.use('/auth', authRoutes);

// Everything below requires a valid JWT.
router.use('/members', authMiddleware, memberRoutes);
router.use('/payments', authMiddleware, paymentRoutes);
router.use('/visitors', authMiddleware, visitorRoutes);
router.use('/settings', authMiddleware, settingsRoutes);
router.use('/export', authMiddleware, exportRoutes);

module.exports = router;
