const fs = require('fs');
const path = require('path');

const ALLOWED_USERS_FILE = path.join(__dirname, '..', 'config', 'allowedUsers.json');

// config/allowedUsers.json is ONLY a one-time starter list: it's read once,
// the first time a database starts with no OTP login accounts at all (see
// seed/ensureMasterData.js#ensureUsers), and never read or written after that.
// Allowed Users live in the database (users collection) - so whatever copy of
// this file a code deploy carries can never change a server's logins.
//
// Each entry is { "phone": "9876543210", "name": "...", "email": "..." }.
function readAllowedUsers() {
  if (!fs.existsSync(ALLOWED_USERS_FILE)) return [];
  const raw = fs.readFileSync(ALLOWED_USERS_FILE, 'utf-8');
  let users;
  try {
    users = JSON.parse(raw);
  } catch (err) {
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
