const fs = require('fs');
const path = require('path');

const MEMBERS_FILE = path.join(__dirname, '..', 'data', 'members.json');

// Reads members.json fresh on every call so edits to the file are picked up
// immediately without restarting the server.
function readMembers() {
  const raw = fs.readFileSync(MEMBERS_FILE, 'utf-8');
  const members = JSON.parse(raw);
  if (!Array.isArray(members)) {
    throw new Error('members.json must contain an array of members');
  }
  return members;
}

function findMemberById(id) {
  return readMembers().find((m) => m.id === id) || null;
}

module.exports = { readMembers, findMemberById };
