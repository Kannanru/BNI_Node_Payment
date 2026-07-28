const express = require('express');
const { listAdmins, listMembersForPicker, setMemberAdmins } = require('../controllers/adminController');

const router = express.Router();

router.get('/', listAdmins);
router.get('/members', listMembersForPicker);
// Accepts { memberIds: string[] } - the complete desired set of member-admins;
// anyone missing from it who's currently an Admin is demoted.
router.put('/members', setMemberAdmins);

module.exports = router;
