const express = require('express');
const { listMembers, getPendingMonths } = require('../controllers/memberController');

const router = express.Router();

router.get('/', listMembers);
router.get('/:memberId/pending-months', getPendingMonths);

module.exports = router;
