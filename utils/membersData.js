const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const Member = require('../models/Member');

// The member roster lives in MongoDB (models/Member.js). data/members.json
// (or MEMBERS_FILE) is only read ONCE - the first time the server starts with
// an empty members collection - to import the existing roster; after that the
// database is the only source of truth and the file is left as a backup.
const DEFAULT_MEMBERS_FILE = path.join(__dirname, '..', 'data', 'members.json');

function membersFilePath() {
  return env.membersFile || DEFAULT_MEMBERS_FILE;
}

// The plain shape every caller works with - same fields the old JSON roster
// had, plus creation/deletion info for the history timeline.
function toPlain(doc) {
  return {
    id: doc.memberId,
    name: doc.name,
    phone: doc.phone || '',
    ...(doc.email ? { email: doc.email } : {}),
    createdAt: doc.createdAt,
    createdBy: doc.createdBy || null,
    importedFromFile: Boolean(doc.importedFromFile),
    isDeleted: Boolean(doc.isDeleted),
    deletedAt: doc.deletedAt || null,
    deletedBy: doc.deletedBy || null,
  };
}

// Active members in creation order. includeDeleted also returns soft-deleted
// ones (history/seed lookups only - never shown in the app's lists).
async function readMembers({ includeDeleted = false } = {}) {
  const filter = includeDeleted ? {} : { isDeleted: { $ne: true } };
  const docs = await Member.find(filter).sort({ seq: 1 }).lean();
  return docs.map(toPlain);
}

async function findMemberById(id, { includeDeleted = false } = {}) {
  if (!id) return null;
  const filter = { memberId: String(id) };
  if (!includeDeleted) filter.isDeleted = { $ne: true };
  const doc = await Member.findOne(filter).lean();
  return doc ? toPlain(doc) : null;
}

// Next "m<n>" id from the highest number ever issued - deleted members
// included - so an id is never handed to a second person.
async function nextMemberSeq() {
  const last = await Member.findOne({}).sort({ seq: -1 }).select('seq').lean();
  return (last ? last.seq : 0) + 1;
}

async function addMember({ name, phone }, actor) {
  const seq = await nextMemberSeq();
  const doc = await Member.create({
    memberId: `m${seq}`,
    seq,
    name,
    phone: phone || '',
    createdBy: actor || null,
  });
  return toPlain(doc.toObject());
}

// Updates a member's name and/or phone (only the fields passed). Returns
// { before, after }, or null if the member doesn't exist (or was deleted) so
// callers can 404.
async function updateMemberById(id, { name, phone }) {
  const doc = await Member.findOne({ memberId: id, isDeleted: { $ne: true } });
  if (!doc) return null;
  const before = toPlain(doc.toObject());
  if (name !== undefined) doc.name = name;
  if (phone !== undefined) doc.phone = phone;
  await doc.save();
  return { before, after: toPlain(doc.toObject()) };
}

// Another active member already using this phone number, if any.
async function findMemberByPhone(phone, { excludeId } = {}) {
  const filter = { phone, isDeleted: { $ne: true } };
  if (excludeId) filter.memberId = { $ne: excludeId };
  const doc = await Member.findOne(filter).lean();
  return doc ? toPlain(doc) : null;
}

// Soft delete - the member is hidden from the app but stays in the database
// together with all their payments and visitors. Returns the deleted member,
// or null if not found.
async function softDeleteMember(id, actor) {
  const doc = await Member.findOneAndUpdate(
    { memberId: id, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: actor || null } },
    { new: true }
  ).lean();
  return doc ? toPlain(doc) : null;
}

// One-time import of the JSON roster into MongoDB. Runs on every start but
// only does anything while the members collection is completely empty, so it
// can never duplicate or overwrite members already in the database.
async function importMembersFromFileIfEmpty() {
  const existing = await Member.estimatedDocumentCount();
  if (existing > 0) return { imported: 0 };

  const filePath = membersFilePath();
  if (!fs.existsSync(filePath)) {
    console.warn(`[members] No members in the database and no ${filePath} to import from.`);
    return { imported: 0 };
  }

  let members;
  try {
    members = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`${filePath} contains invalid JSON (${err.message}) - fix it, then restart to import members.`);
  }
  if (!Array.isArray(members)) throw new Error(`${filePath} must contain an array of members`);

  const docs = members.map((m) => {
    const match = /^m(\d+)$/.exec(m.id || '');
    if (!match) throw new Error(`Member "${m.name}" in ${filePath} has an invalid id "${m.id}"`);
    return {
      memberId: m.id,
      seq: Number(match[1]),
      name: String(m.name || '').trim(),
      phone: m.phone || '',
      ...(m.email ? { email: m.email } : {}),
      importedFromFile: true,
    };
  });
  await Member.insertMany(docs);
  console.log(`[members] Imported ${docs.length} member(s) from ${filePath} into the database (one-time).`);
  return { imported: docs.length };
}

module.exports = {
  readMembers,
  findMemberById,
  addMember,
  updateMemberById,
  findMemberByPhone,
  softDeleteMember,
  importMembersFromFileIfEmpty,
};
