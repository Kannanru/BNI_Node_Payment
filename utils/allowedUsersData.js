const fs = require('fs');
const path = require('path');

const ALLOWED_USERS_FILE = path.join(__dirname, '..', 'config', 'allowedUsers.json');

// Reads allowedUsers.json fresh on every call (mirrors utils/membersData.js)
// so adding, removing, or editing an entry never needs a code change and is
// never held stale by Node's require() cache - only a server restart is
// needed for a brand new account to actually become able to log in, since
// that's when ensureMasterData.js's ensureUsers() creates its bcrypt-hashed
// User document.
function readAllowedUsers() {
  const raw = fs.readFileSync(ALLOWED_USERS_FILE, 'utf-8');
  let users;
  try {
    users = JSON.parse(raw);
  } catch (err) {
    // Hand-editing this file is the expected workflow (see the comment
    // above), so a syntax mistake - most often a trailing comma before ']'
    // or '}', or a missing comma between entries - is the most likely
    // failure here. Surface that plainly instead of letting a bare
    // "Unexpected token" from JSON.parse (with no file name attached) be
    // the only clue.
    throw new Error(
      `config/allowedUsers.json contains invalid JSON (${err.message}). ` +
        'Check for a trailing comma before "]" or "}", or a missing comma between entries, then save and restart.'
    );
  }
  if (!Array.isArray(users)) {
    throw new Error('allowedUsers.json must contain an array of users');
  }
  return users;
}

// Rewrites the matching entry's plaintext password. This file is the
// source of truth ensureMasterData.js's ensureUsers() reconciles Mongo
// against on every server restart - if a password is changed in Mongo
// (User.passwordHash) without also updating it here, the very next restart
// would detect the "mismatch" and silently overwrite the new hash back to
// whatever this file still says. Returns false if the email isn't found, so
// callers can surface an error instead of silently no-op-ing.
function updateAllowedUserPassword(email, newPassword) {
  const users = readAllowedUsers();
  const user = users.find((u) => u.email === email);
  if (!user) return false;
  user.password = newPassword;
  fs.writeFileSync(ALLOWED_USERS_FILE, JSON.stringify(users, null, 2) + '\n', 'utf-8');
  return true;
}

// Appends every entry not already present (e.g. every member just converted
// to Admin in one Admin Access batch) in a single read-modify-write. This
// file - not just the Mongo User document - is what
// ensureMasterData.js's ensureUsers() reconciles against on every restart,
// so skipping this write would mean the very next restart deletes those User
// documents again (their emails wouldn't be on the allowlist). Takes the
// whole batch at once rather than being called once per entry specifically
// so a multi-select conversion does one file read and one write no matter
// how many members were selected, instead of one of each per member.
function addAllowedUsers(entries) {
  const users = readAllowedUsers();
  const existingEmails = new Set(users.map((u) => u.email));
  const additions = entries.filter((e) => !existingEmails.has(e.email));
  if (!additions.length) return 0;
  users.push(...additions);
  fs.writeFileSync(ALLOWED_USERS_FILE, JSON.stringify(users, null, 2) + '\n', 'utf-8');
  return additions.length;
}

// Removes every entry whose email is in `emails` (e.g. every member just
// demoted back to a plain Member in one Admin Access save) in a single
// read-modify-write, mirroring addAllowedUsers. Removing this - not just the
// Mongo User document - is what actually blocks login: authController.js's
// login() checks this file as the gatekeeper before it ever looks at Mongo,
// so leaving a demoted member's entry here would let them keep logging in
// (with their old Admin password) even after their Mongo account is gone.
function removeAllowedUsers(emails) {
  const users = readAllowedUsers();
  const emailSet = new Set(emails);
  const remaining = users.filter((u) => !emailSet.has(u.email));
  const removedCount = users.length - remaining.length;
  if (removedCount > 0) fs.writeFileSync(ALLOWED_USERS_FILE, JSON.stringify(remaining, null, 2) + '\n', 'utf-8');
  return removedCount;
}

module.exports = { readAllowedUsers, updateAllowedUserPassword, addAllowedUsers, removeAllowedUsers };
