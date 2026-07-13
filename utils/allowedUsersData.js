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

module.exports = { readAllowedUsers };
