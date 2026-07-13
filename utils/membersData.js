const fs = require('fs');
const path = require('path');
const env = require('../config/env');

const DEFAULT_MEMBERS_FILE = path.join(__dirname, '..', 'data', 'members.json');

// env.membersFile (from MEMBERS_FILE in .env, gitignored/local-only) lets
// this specific machine point at a different file entirely - e.g. one
// that's already open and edited directly in your editor - without
// affecting the portable default anyone else (or production) gets.
function membersFilePath() {
  return env.membersFile || DEFAULT_MEMBERS_FILE;
}

// Reads the member roster fresh on every call so edits to the file are
// picked up immediately without restarting the server.
function readMembers() {
  const filePath = membersFilePath();
  const raw = fs.readFileSync(filePath, 'utf-8');
  let members;
  try {
    members = JSON.parse(raw);
  } catch (err) {
    // Hand-editing this file is the expected workflow, so a syntax mistake
    // - most often a trailing comma before ']' or '}', or a missing comma
    // between entries - is the most likely failure here. Surface that
    // plainly instead of letting a bare "Unexpected token" from JSON.parse
    // (with no file name attached) be the only clue.
    throw new Error(
      `${filePath} contains invalid JSON (${err.message}). ` +
        'Check for a trailing comma before "]" or "}", or a missing comma between entries, then save and restart.'
    );
  }
  if (!Array.isArray(members)) {
    throw new Error(`${filePath} must contain an array of members`);
  }
  return members;
}

function findMemberById(id) {
  return readMembers().find((m) => m.id === id) || null;
}

module.exports = { readMembers, findMemberById };
