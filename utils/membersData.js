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

// Rewrites members.json without [id]. Returns false (no write performed) if
// the id wasn't present, so callers can 404 instead of silently no-op-ing.
function removeMemberById(id) {
  const members = readMembers();
  const filtered = members.filter((m) => m.id !== id);
  if (filtered.length === members.length) return false;
  fs.writeFileSync(membersFilePath(), JSON.stringify(filtered, null, 2) + '\n', 'utf-8');
  return true;
}

// Ids are "m<number>" but members.json isn't append-only in practice
// anymore now that deleteMember can leave gaps (e.g. m71 missing after a
// delete) - so the next id is derived from the highest numeric suffix
// currently present, not the array length, to avoid ever reissuing one that
// used to belong to a deleted member.
function nextMemberId(members) {
  let max = 0;
  for (const m of members) {
    const match = /^m(\d+)$/.exec(m.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `m${max + 1}`;
}

// Appends a new member to members.json and returns the created record.
function addMember({ name, email }) {
  const members = readMembers();
  const member = { id: nextMemberId(members), name, email };
  members.push(member);
  fs.writeFileSync(membersFilePath(), JSON.stringify(members, null, 2) + '\n', 'utf-8');
  return member;
}

// Renames an existing member in place. Deliberately name-only - email is
// never accepted here (see memberController.js#updateMember) since it's
// stored purely for backend use (Admin Access conversion) and is never
// surfaced to the UI at all; an edit flow that showed/collected it would
// put it on screen for the first time. id is immutable (it's the foreign
// key Payment.memberId/Visitor.memberId reference) and isn't accepted
// either. Returns null (no write performed) if the id doesn't exist, so
// callers can 404 instead of silently no-op-ing.
function updateMemberById(id, { name }) {
  const members = readMembers();
  const member = members.find((m) => m.id === id);
  if (!member) return null;
  member.name = name;
  fs.writeFileSync(membersFilePath(), JSON.stringify(members, null, 2) + '\n', 'utf-8');
  return member;
}

module.exports = { readMembers, findMemberById, removeMemberById, addMember, updateMemberById };
