// Idempotent startup seeding: called automatically from server.js on every
// `npm start`/`npm run dev`, so the required master data is always present
// without ever duplicating records that already exist. Safe to run on every
// boot - each piece only inserts what's actually missing.
//
// Covers:
//   1. The two login accounts (config/allowedUsers.js) - always kept in
//      sync, unaffected by anything else this module does.
//   2. July 2026 member payment records + the July visitor placeholder,
//      sourced from "WEEK AFTER WEEK PAYMENTS.xlsx" (see seedJulyOnly.js for
//      the one-off destructive version this was derived from).
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
const { ALLOWED_USERS } = require('../config/allowedUsers');
const { readMembers } = require('../utils/membersData');

const EXCEL_PATH = path.join(
  __dirname,
  '..', '..', '..',
  'bni_mobile_app', 'BNI_Flutter_payment', 'WEEK AFTER WEEK PAYMENTS.xlsx'
);
const SHEET_NAME = 'july 26';
const MONTH_KEY = '2026-07';
const NAME_OVERRIDES = new Map([['SRIDHAR J', 'SRIDAR J']]);

function norm(s) {
  return String(s).trim().replace(/\s+/g, ' ').toUpperCase();
}

function cellText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && v.text) return v.text;
  if (typeof v === 'object' && v.richText) return v.richText.map((rt) => rt.text).join('');
  return String(v);
}

function parseSheetDate(str) {
  const [d, m, y] = str.split('.').map(Number);
  return { year: 2000 + y, month: m, day: d };
}

function randomPaidAt(year, month, day) {
  const hour = 9;
  const minute = Math.floor(Math.random() * 60);
  const second = Math.floor(Math.random() * 60);
  return new Date(year, month - 1, day, hour, minute, second);
}

// Always kept present and in sync - deletes any User not on the allowlist,
// upserts the two allowed accounts. Untouched by the payment-data seeding
// below (separate collection, separate logic).
async function ensureUsers() {
  const allowedEmails = ALLOWED_USERS.map((u) => u.email);
  const { deletedCount } = await User.deleteMany({ email: { $nin: allowedEmails } });
  if (deletedCount > 0) console.log(`[seed] Removed ${deletedCount} account(s) not on the allowlist.`);

  let created = 0;
  for (const { email, name, password } of ALLOWED_USERS) {
    const existing = await User.findOne({ email });
    if (existing) continue; // already present - leave the existing hash alone
    const passwordHash = await bcrypt.hash(password, 10);
    await User.create({ email, name, passwordHash });
    created += 1;
  }
  console.log(`[seed] Users: ${ALLOWED_USERS.length} allowed, ${created} newly created.`);
}

// Parses the July sheet into the same shape as seedJulyOnly.js, but never
// deletes anything - only returns docs to insert for whatever isn't already
// in the database (see ensurePaymentData below for the actual comparison).
async function parseJulySheet() {
  const members = readMembers();
  const nameToId = new Map(members.map((m) => [norm(m.name), m.id]));
  const viswanathanId = nameToId.get(norm('VISWANATHAN S'));
  if (!viswanathanId) throw new Error('VISWANATHAN S not found in members.json - needed as the visitor placeholder host');

  function resolveMemberId(rawName) {
    const overridden = NAME_OVERRIDES.get(norm(rawName)) || rawName;
    const id = nameToId.get(norm(overridden));
    if (!id) throw new Error(`Unmatched member name in Excel: "${rawName}"`);
    return id;
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_PATH);
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) throw new Error(`Sheet not found: ${SHEET_NAME}`);

  const row1 = ws.getRow(1);
  const row2 = ws.getRow(2);
  const columns = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    const label = cellText(row2.getCell(c).value);
    if (!label) continue;
    const kind = label.trim().toUpperCase();
    if (kind === 'CASH' || kind === 'UPI') {
      const dateStr = cellText(row1.getCell(c).value);
      if (dateStr) columns.push({ col: c, kind: kind === 'CASH' ? 'cash' : 'upi', dateStr });
    } else if (kind === 'OLD') {
      columns.push({ col: c, kind: 'old' });
    }
  }

  let visitorRowTotal = 0;
  for (let r = 4; r <= ws.rowCount; r++) {
    const nameVal = cellText(ws.getRow(r).getCell(2).value);
    if (nameVal && norm(nameVal) === 'VISITOR') visitorRowTotal += 1;
  }

  const paymentDocs = [];
  const visitorDocs = [];
  let visitorRowIndex = 0;

  for (let r = 4; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rawName = cellText(row.getCell(2).value);
    if (!rawName) continue;
    const isVisitorRow = norm(rawName) === 'VISITOR';

    const transactions = [];
    for (const { col, kind, dateStr } of columns) {
      const value = row.getCell(col).value;
      if (typeof value !== 'number' || value <= 0) continue;
      if (kind === 'old') continue; // pre-July due - out of scope, same as seedJulyOnly.js
      transactions.push({ amount: value, method: kind, dateStr });
    }

    if (isVisitorRow) {
      visitorRowIndex += 1;
      if (!transactions.length) continue;
      const label = visitorRowTotal > 1 ? `Visitor ${visitorRowIndex} - ${MONTH_KEY}` : `Visitor 1 - ${MONTH_KEY}`;
      visitorDocs.push({
        memberId: viswanathanId,
        name: label,
        email: `visitor.${MONTH_KEY.replace('-', '')}.${visitorRowIndex}@placeholder.bni-agaram.local`,
        phone: '0000000000',
        payments: transactions.map(({ amount, method, dateStr: ds }) => {
          const { year, month, day } = parseSheetDate(ds);
          return { _id: new mongoose.Types.ObjectId(), method, amount, paidAt: randomPaidAt(year, month, day) };
        }),
      });
      continue;
    }

    const memberId = resolveMemberId(rawName);
    for (const { amount, method, dateStr: ds } of transactions) {
      const { year, month, day } = parseSheetDate(ds);
      paymentDocs.push({ memberId, month: MONTH_KEY, amount, method, paidAt: randomPaidAt(year, month, day) });
    }
  }

  return { paymentDocs, visitorDocs };
}

// Inserts only the Payment transactions that don't already exist, matched by
// {memberId, month, amount, method} - the same (member, month, amount,
// method) combination is treated as "already seeded" regardless of exact
// paidAt time, since that's randomized on every seed run and isn't a
// meaningful identity field. Genuinely new/different transactions (e.g. if
// the Excel is later updated) still get inserted.
async function ensurePaymentData(paymentDocs) {
  if (!paymentDocs.length) return { inserted: 0 };

  const memberIds = [...new Set(paymentDocs.map((p) => p.memberId))];
  const existing = await Payment.find({ memberId: { $in: memberIds }, month: MONTH_KEY })
    .select('memberId amount method')
    .lean();
  const existingKeys = new Set(existing.map((p) => `${p.memberId}|${p.amount}|${p.method}`));

  const toInsert = paymentDocs.filter((p) => !existingKeys.has(`${p.memberId}|${p.amount}|${p.method}`));
  if (toInsert.length) await Payment.insertMany(toInsert);
  return { inserted: toInsert.length, skipped: paymentDocs.length - toInsert.length };
}

// Inserts a visitor placeholder only if no Visitor with that exact name
// already exists - the whole doc (including its payments) is skipped as a
// unit rather than merged, since these are one-off placeholders, not
// something that gains new transactions over time.
async function ensureVisitorData(visitorDocs) {
  if (!visitorDocs.length) return { inserted: 0 };

  const names = visitorDocs.map((v) => v.name);
  const existingNames = new Set((await Visitor.find({ name: { $in: names } }).select('name').lean()).map((v) => v.name));

  const toInsert = visitorDocs.filter((v) => !existingNames.has(v.name));
  if (!toInsert.length) return { inserted: 0, skipped: visitorDocs.length };

  const createdAt = new Date(2026, 6, 1, 9, 0, 0); // July 1, 2026
  await Visitor.collection.insertMany(toInsert.map((v) => ({ ...v, createdAt, updatedAt: createdAt })));
  return { inserted: toInsert.length, skipped: visitorDocs.length - toInsert.length };
}

async function ensureJulyPaymentData() {
  if (!fs.existsSync(EXCEL_PATH)) {
    console.warn(`[seed] Excel source not found at ${EXCEL_PATH} - skipping July payment/visitor seeding.`);
    return;
  }

  const { paymentDocs, visitorDocs } = await parseJulySheet();
  const paymentResult = await ensurePaymentData(paymentDocs);
  const visitorResult = await ensureVisitorData(visitorDocs);

  console.log(
    `[seed] July payments: ${paymentResult.inserted} inserted, ${paymentResult.skipped || 0} already present.`
  );
  console.log(
    `[seed] Visitor placeholders: ${visitorResult.inserted} inserted, ${visitorResult.skipped || 0} already present.`
  );
}

async function ensureMasterData() {
  await ensureUsers();
  await ensureJulyPaymentData();
}

module.exports = { ensureMasterData, ensureUsers, ensureJulyPaymentData };
