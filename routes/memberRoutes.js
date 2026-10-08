const express = require('express');
const {
  listMembers,
  getPendingMonths,
  deleteMember,
  createMember,
  updateMember,
  getMemberHistory,
} = require('../controllers/memberController');

const router = express.Router();

router.get('/', listMembers);
router.get('/:memberId/pending-months', getPendingMonths);
router.get('/:memberId/history', getMemberHistory);
router.post('/', createMember);
router.patch('/:memberId', updateMember);
router.delete('/:memberId', deleteMember);

module.exports = router;
