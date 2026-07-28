const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { readMembers, findMemberById } = require('../utils/membersData');
const { addAllowedUsers, removeAllowedUsers } = require('../utils/allowedUsersData');

// Matches every other seeded account's password in config/allowedUsers.json
// (kannan@bni123, neha@bni123, ap@bni123, ...) - the email's prefix (before
// the @) with "@bni123" appended, so a newly promoted Admin's password is
// predictable the same way the original allowlist's always were.
function derivePasswordFromEmail(email) {
  const prefix = email.split('@')[0];
  return `${prefix}@bni123`;
}

// Powers the Admin Access screen's list - every account that currently has
// admin privileges, most recently granted first so a just-promoted member
// shows up at the top. Deliberately includes accounts with no corresponding
// member record (e.g. staff logins seeded before the member roster had
// emails at all) - this is "who can log in as Admin right now", a strictly
// larger set than "which members are Admins" (see listMembersForPicker).
async function listAdmins(req, res, next) {
  try {
    const admins = await User.find({ role: 'admin' }).sort({ createdAt: -1 }).lean();
    res.json({
      admins: admins.map((u) => ({ id: u._id.toString(), name: u.name, email: u.email })),
    });
  } catch (err) {
    next(err);
  }
}

// Powers the "Manage Admin Access" sheet: every member, each flagged with
// whether they currently have Admin access, so the sheet can pre-check them.
// hasEmail is surfaced separately from isAdmin so the UI can grey out (rather
// than silently fail on save) a member with no email on file - there's no
// login identity to ever make them Admin against.
//
// Not every current Admin corresponds to a member here (see listAdmins) -
// those accounts simply never appear as a row to check or uncheck, which is
// exactly the point: setMemberAdmins below only ever reconciles Admin status
// for members it can show a checkbox for, so an admin account with no
// matching member is never at risk of being silently demoted just because
// this member-only picker has no way to represent it as "selected".
async function listMembersForPicker(req, res, next) {
  try {
    const admins = await User.find({ role: 'admin' }).select('email').lean();
    const adminEmails = new Set(admins.map((u) => u.email.toLowerCase()));

    const members = readMembers()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        hasEmail: Boolean(m.email),
        isAdmin: Boolean(m.email && adminEmails.has(m.email.toLowerCase())),
      })),
    });
  } catch (err) {
    next(err);
  }
}

// Promotes one member into a full Admin account: creates the login (password
// derived from their email - see derivePasswordFromEmail - since there's no
// signup UI for the member to set their own). Doesn't touch
// config/allowedUsers.json itself - the caller collects every newly-allowed
// entry across the whole batch and writes it once (see setMemberAdmins)
// rather than this function reading and rewriting that file on every single
// call, which is both slower for a multi-select batch and, if ever run
// concurrently, a lost-update race (two reads of the same stale file, each
// unaware of the other's write).
//
// `adminEmails` is the caller's running set of every email that already has
// (or, earlier in this same batch, just gained) Admin access - checked
// instead of a fresh Mongo query so that selecting two members who happen to
// resolve to the same email within one batch is caught too.
async function promoteOneMember(memberId, adminEmails) {
  const member = findMemberById(memberId);
  if (!member) {
    return { ok: false, memberId, message: 'Member not found' };
  }
  if (!member.email) {
    return { ok: false, memberId, name: member.name, message: `${member.name} has no email on file and cannot be made an Admin.` };
  }

  const email = member.email.toLowerCase().trim();
  if (adminEmails.has(email)) {
    return { ok: false, memberId, name: member.name, message: `${member.name} already has Admin access.` };
  }

  const temporaryPassword = derivePasswordFromEmail(email);
  const passwordHash = await bcrypt.hash(temporaryPassword, 10);
  const user = await User.findOneAndUpdate(
    { email },
    { $set: { name: member.name, email, passwordHash, role: 'admin' } },
    { upsert: true, new: true }
  );

  adminEmails.add(email);
  return {
    ok: true,
    admin: { id: user.id, name: user.name, email: user.email },
    temporaryPassword,
    allowedEntry: { email, name: member.name, password: temporaryPassword },
  };
}

// Reconciles Admin status for members against the caller's desired complete
// set (memberIds = everyone who should end up checked). Anyone currently
// Admin-via-membership but missing from that set is demoted back to a plain
// Member - their login is deleted outright (Mongo User doc AND their
// config/allowedUsers.json entry) rather than just marking a role, since a
// Member has no login account at all in this app's model; "no longer Admin"
// and "no longer able to log in" are the same thing here, not two separate
// states.
//
// Runs every promotion/demotion sequentially (not Promise.all) for the same
// reason convertOneMember always has: the allowedUsers.json read-modify-write
// at the end must reflect every change from this one save, and concurrent
// writers reading the same stale file would silently lose each other's
// changes.
async function setMemberAdmins(req, res, next) {
  try {
    if (!Array.isArray(req.body.memberIds)) {
      return res.status(400).json({ message: 'memberIds must be an array' });
    }
    const desiredIds = new Set(req.body.memberIds.map((id) => String(id).trim()).filter(Boolean));

    const members = readMembers();
    const membersById = new Map(members.map((m) => [m.id, m]));

    const admins = await User.find({ role: 'admin' }).select('email').lean();
    const adminEmails = new Set(admins.map((u) => u.email.toLowerCase()));

    // Only members whose email currently belongs to an Admin count as
    // "currently Admin" for this reconciliation - an Admin account with no
    // matching member (see listMembersForPicker's doc comment) is out of
    // scope entirely and can never end up in toDemote.
    const currentlyAdminMemberIds = new Set();
    for (const member of members) {
      if (member.email && adminEmails.has(member.email.toLowerCase())) {
        currentlyAdminMemberIds.add(member.id);
      }
    }

    const toPromote = [...desiredIds].filter((id) => !currentlyAdminMemberIds.has(id));
    const toDemote = [...currentlyAdminMemberIds].filter((id) => !desiredIds.has(id));

    const promoted = [];
    const demoted = [];
    const failed = [];
    const newAllowedEntries = [];
    const removedEmails = [];

    for (const memberId of toPromote) {
      const result = await promoteOneMember(memberId, adminEmails);
      if (result.ok) {
        promoted.push({ ...result.admin, temporaryPassword: result.temporaryPassword });
        newAllowedEntries.push(result.allowedEntry);
      } else {
        failed.push({ memberId: result.memberId, name: result.name, message: result.message });
      }
    }

    for (const memberId of toDemote) {
      const member = membersById.get(memberId);
      const email = member.email.toLowerCase().trim();
      await User.deleteOne({ email });
      removedEmails.push(email);
      demoted.push({ id: memberId, name: member.name, email });
    }

    if (newAllowedEntries.length) addAllowedUsers(newAllowedEntries);
    if (removedEmails.length) removeAllowedUsers(removedEmails);

    res.json({ promoted, demoted, failed });
  } catch (err) {
    next(err);
  }
}

module.exports = { listAdmins, listMembersForPicker, setMemberAdmins };
