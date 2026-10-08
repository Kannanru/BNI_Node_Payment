const fs = require('fs');
const path = require('path');
const { normalizePhone } = require('./phone');

const ALLOWED_USERS_FILE = path.join(__dirname, '..', 'config', 'allowedUsers.json');

// Reads allowedUsers.json fresh on every call (mirrors utils/membersData.js)
// so adding, removing, or editing an entry never needs a code change and is
// never held stale by Node's require() cache - only a server restart is
// needed for a brand new account to actually become able to log in, since
// that's when ensureMasterData.js's ensureUsers() creates its User document.
//
// Each entry is { "phone": "9876543210", "name": "...", "email": "..." } -
// phone is the login identity (SMS OTP), email is optional and informational.
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

// Appends every entry not already present (e.g. every member just converted
// to Admin in one Admin Access batch) in a single read-modify-write. This
// file - not just the Mongo User document - is what
// ensureMasterData.js's ensureUsers() reconciles against on every restart,
// so skipping this write would mean the very next restart deletes those User
// documents again (their numbers wouldn't be on the allowlist).
function addAllowedUsers(entries) {
  const users = readAllowedUsers();
  const existingPhones = new Set(users.map((u) => normalizePhone(u.phone)).filter(Boolean));
  const additions = entries.filter((e) => !existingPhones.has(e.phone));
  if (!additions.length) return 0;
  users.push(...additions);
  fs.writeFileSync(ALLOWED_USERS_FILE, JSON.stringify(users, null, 2) + '\n', 'utf-8');
  return additions.length;
}

// Removes every entry whose phone is in `phones` (e.g. every member just
// demoted back to a plain Member in one Admin Access save) in a single
// read-modify-write, mirroring addAllowedUsers. Removing this - not just the
// Mongo User document - is what actually blocks login: authController.js
// checks this file as the gatekeeper before it ever sends an OTP.
function removeAllowedUsers(phones) {
  const users = readAllowedUsers();
  const phoneSet = new Set(phones);
  const remaining = users.filter((u) => !phoneSet.has(normalizePhone(u.phone)));
  const removedCount = users.length - remaining.length;
  if (removedCount > 0) fs.writeFileSync(ALLOWED_USERS_FILE, JSON.stringify(remaining, null, 2) + '\n', 'utf-8');
  return removedCount;
}

// Moves an allowlisted login from [oldPhone] to [newPhone] (a member who is an
// Admin got a new number). Returns false if [oldPhone] wasn't allowlisted.
function updateAllowedUserPhone(oldPhone, newPhone) {
  const users = readAllowedUsers();
  const entry = users.find((u) => normalizePhone(u.phone) === oldPhone);
  if (!entry) return false;
  entry.phone = newPhone;
  fs.writeFileSync(ALLOWED_USERS_FILE, JSON.stringify(users, null, 2) + '\n', 'utf-8');
  return true;
}

module.exports = { readAllowedUsers, addAllowedUsers, removeAllowedUsers, updateAllowedUserPhone };
