const express = require('express');
const { login, verifyPassword, changePassword } = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/login', login);
// /auth is otherwise unauthenticated (see routes/index.js), so these routes
// apply authMiddleware themselves - each needs to know which account is
// making the request.
router.post('/verify-password', authMiddleware, verifyPassword);
router.post('/change-password', authMiddleware, changePassword);

module.exports = router;
