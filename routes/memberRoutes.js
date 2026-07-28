const express = require('express');
const { listMembers, getPendingMonths, deleteMember, createMember } = require('../controllers/memberController');

const router = express.Router();

router.get('/', listMembers);
router.get('/:memberId/pending-months', getPendingMonths);
router.post('/', createMember);
router.delete('/:memberId', deleteMember);

module.exports = router;
