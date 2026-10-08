const User = require('../models/User');
const { readMembers, findMemberById } = require('../utils/membersData');
const { addAllowedUsers, removeAllowedUsers } = require('../utils/allowedUsersData');
const { normalizePhone } = require('../utils/phone');

// Powers the Admin Access screen's list - every account that currently has
// admin privileges, most recently granted first so a just-promoted member
// shows up at the top. Deliberately includes accounts with no corresponding
// member record (e.g. staff logins seeded straight into allowedUsers.json) -
// this is "who can log in as Admin right now", a strictly larger set than
// "which members are Admins" (see listMembersForPicker).
async function listAdmins(req, res, next) {
  try {
    const admins = await User.find({ role: 'admin' }).sort({ createdAt: -1 }).lean();
    res.json({
      admins: admins.map((u) => ({ id: u._id.toString(), name: u.name, phone: u.phone })),
    });
  } catch (err) {
    next(err);
  }
}

// Powers the "Manage Admin Access" sheet: every member, each flagged with
// whether they currently have Admin access, so the sheet can pre-check them.
// hasPhone is surfaced separately from isAdmin so the UI can grey out (rather
// than silently fail on save) a member with no valid mobile number on file -
// there's no login identity to ever send them an OTP.
//
// Not every current Admin corresponds to a member here (see listAdmins) -
// those accounts simply never appear as a row to check or uncheck, which is
// exactly the point: setMemberAdmins below only ever reconciles Admin status
// for members it can show a checkbox for, so an admin account with no
// matching member is never at risk of being silently demoted just because
// this member-only picker has no way to represent it as "selected".
async function listMembersForPicker(req, res, next) {
  try {
    const admins = await User.find({ role: 'admin' }).select('phone').lean();
    const adminPhones = new Set(admins.map((u) => u.phone));

    const members = (await readMembers())
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      members: members.map((m) => {
        const phone = normalizePhone(m.phone);
        return {
          id: m.id,
          name: m.name,
          hasPhone: Boolean(phone),
          isAdmin: Boolean(phone && adminPhones.has(phone)),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
}

// Promotes one member into a full Admin account. Nothing to hand out - they
// simply log in with an OTP sent to the mobile number on file. Doesn't touch
// config/allowedUsers.json itself - the caller collects every newly-allowed
// entry across the whole batch and writes it once (see setMemberAdmins)
// rather than this function reading and rewriting that file on every single
// call, which is both slower for a multi-select batch and, if ever run
// concurrently, a lost-update race.
//
// `adminPhones` is the caller's running set of every number that already has
// (or, earlier in this same batch, just gained) Admin access - checked
// instead of a fresh Mongo query so that selecting two members who happen to
// share a number within one batch is caught too.
async function promoteOneMember(memberId, adminPhones) {
  const member = await findMemberById(memberId);
  if (!member) {
    return { ok: false, memberId, message: 'Member not found' };
  }

  const phone = normalizePhone(member.phone);
  if (!phone) {
    return { ok: false, memberId, name: member.name, message: `${member.name} has no mobile number on file and cannot be made an Admin.` };
  }
  if (adminPhones.has(phone)) {
    return { ok: false, memberId, name: member.name, message: `${member.name} already has Admin access.` };
  }

  const email = member.email ? member.email.toLowerCase().trim() : undefined;
  const user = await User.findOneAndUpdate(
    { phone },
    { $set: { name: member.name, phone, role: 'admin', ...(email ? { email } : {}) } },
    { upsert: true, new: true }
  );

  adminPhones.add(phone);
  return {
    ok: true,
    admin: { id: user.id, name: user.name, phone: user.phone },
    allowedEntry: { phone, name: member.name, ...(email ? { email } : {}) },
  };
}

// Reconciles Admin status for members against the caller's desired complete
// set (memberIds = everyone who should end up checked). Anyone currently
// Admin-via-membership but missing from that set is demoted back to a plain
// Member - their login is deleted outright (Mongo User doc AND their
// config/allowedUsers.json entry) rather than just marking a role, since a
// Member has no login account at all in this app's model.
//
// Runs every promotion/demotion sequentially (not Promise.all) so the
// allowedUsers.json write at the end reflects every change from this save.
async function setMemberAdmins(req, res, next) {
  try {
    if (!Array.isArray(req.body.memberIds)) {
      return res.status(400).json({ message: 'memberIds must be an array' });
    }
    const desiredIds = new Set(req.body.memberIds.map((id) => String(id).trim()).filter(Boolean));

    const members = await readMembers();
    const membersById = new Map(members.map((m) => [m.id, m]));

    const admins = await User.find({ role: 'admin' }).select('phone').lean();
    const adminPhones = new Set(admins.map((u) => u.phone));

    // Only members whose number currently belongs to an Admin count as
    // "currently Admin" for this reconciliation - an Admin account with no
    // matching member (see listMembersForPicker's doc comment) is out of
    // scope entirely and can never end up in toDemote.
    const currentlyAdminMemberIds = new Set();
    for (const member of members) {
      const phone = normalizePhone(member.phone);
      if (phone && adminPhones.has(phone)) currentlyAdminMemberIds.add(member.id);
    }

    const toPromote = [...desiredIds].filter((id) => !currentlyAdminMemberIds.has(id));
    const toDemote = [...currentlyAdminMemberIds].filter((id) => !desiredIds.has(id));

    const promoted = [];
    const demoted = [];
    const failed = [];
    const newAllowedEntries = [];
    const removedPhones = [];

    for (const memberId of toPromote) {
      const result = await promoteOneMember(memberId, adminPhones);
      if (result.ok) {
        promoted.push(result.admin);
        newAllowedEntries.push(result.allowedEntry);
      } else {
        failed.push({ memberId: result.memberId, name: result.name, message: result.message });
      }
    }

    for (const memberId of toDemote) {
      const member = membersById.get(memberId);
      const phone = normalizePhone(member.phone);
      await User.deleteOne({ phone });
      removedPhones.push(phone);
      demoted.push({ id: memberId, name: member.name, phone });
    }

    if (newAllowedEntries.length) addAllowedUsers(newAllowedEntries);
    if (removedPhones.length) removeAllowedUsers(removedPhones);

    res.json({ promoted, demoted, failed });
  } catch (err) {
    next(err);
  }
}

module.exports = { listAdmins, listMembersForPicker, setMemberAdmins };
