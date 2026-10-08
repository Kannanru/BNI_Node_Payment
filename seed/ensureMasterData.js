// Idempotent startup seeding: called automatically from server.js on every
// `npm start`/`npm run dev`, so the required master data is always present
// without ever duplicating records that already exist. Safe to run on every
// boot - each piece only inserts what's actually missing.
//
// Covers:
//   1. The login accounts (config/allowedUsers.json) - always kept in sync,
//      unaffected by anything else this module does.
//   2. July 2026 member payment records + the July visitor placeholder,
//      sourced from "WEEK AFTER WEEK PAYMENTS.xlsx" (see seedJulyOnly.js for
//      the one-off destructive version this was derived from).
//
// The source workbook lives in data/ alongside members.json - inside this
// repo, not the sibling Flutter app folder - specifically so it's part of
// the deployed artifact. A relative path reaching outside the repo would
// resolve to nothing on any server that doesn't happen to share this dev
// machine's folder layout (e.g. production), silently skipping this section
// instead of erroring loudly.
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
const SeedState = require('../models/SeedState');
const FeeSchedule = require('../models/FeeSchedule');
const MonthlyFee = require('../models/MonthlyFee');
const { loadFeeSchedule, levelFeeFromSchedule } = require('../utils/feeSchedule');
const { monthKeyOf } = require('../utils/monthRange');
const { readAllowedUsers } = require('../utils/allowedUsersData');
const { readMembers } = require('../utils/membersData');
const { normalizePhone } = require('../utils/phone');
const { getOrCreateSettings } = require('../utils/getSettings');

const EXCEL_PATH = path.join(__dirname, '..', 'data', 'WEEK AFTER WEEK PAYMENTS.xlsx');
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

// Login accounts (Allowed Users) live in the database - the users
// collection is the ONLY source of truth. config/allowedUsers.json is read
// at most ONCE per database, to create the first OTP login accounts, and is
// never read again after that. So deploying new code (including whatever
// copy of that file the code contains) can never add, change or remove a
// production login. Manage logins afterwards with Admin Access in the app or
// `npm run admins` (seed/manageAdmins.js).
const USERS_IMPORT_KEY = 'allowed-users-import';

async function ensureUsers() {
  await User.syncIndexes().catch(() => {}); // see importUsersFromFile for the first-run case

  if (await SeedState.exists({ key: USERS_IMPORT_KEY })) {
    console.log('[seed] Allowed users: managed in the database - allowedUsers.json ignored.');
    return;
  }

  // This database already has OTP login accounts (it ran the phone-login
  // code before this rule existed) - those ARE its allowed users. Keep them
  // exactly as they are and just record that the import is done.
  if (await User.exists({ phone: { $exists: true } })) {
    await SeedState.create({ key: USERS_IMPORT_KEY, note: 'Existing OTP accounts kept - file not imported.' });
    console.log('[seed] Allowed users: existing accounts kept as-is; allowedUsers.json will no longer be used.');
    return;
  }

  await importUsersFromFile();
  await SeedState.create({ key: USERS_IMPORT_KEY, note: 'Imported from config/allowedUsers.json.' });
}

// First-ever OTP start on an empty database: creates the login accounts from
// config/allowedUsers.json. Runs once (see ensureUsers).
async function importUsersFromFile() {
  const allowedUsers = readAllowedUsers();

  const valid = [];
  for (const entry of allowedUsers) {
    const phone = normalizePhone(entry.phone);
    if (!phone) {
      console.warn(`[seed] WARNING: "${entry.name}" in allowedUsers.json has no valid 10-digit phone - skipped, cannot log in.`);
      continue;
    }
    valid.push({ phone, name: entry.name, email: entry.email ? String(entry.email).toLowerCase().trim() : undefined });
  }

  // Pre-OTP accounts were keyed by a unique email and have no phone at all.
  // They must be gone before syncIndexes swaps the old unique email index
  // for the unique phone one - otherwise building the phone index fails on
  // several documents sharing a missing phone, and the old email index
  // rejects new accounts that have no email.
  await User.deleteMany({ phone: { $exists: false } });
  await User.syncIndexes();

  const { deletedCount } = await User.deleteMany({ phone: { $nin: valid.map((u) => u.phone) } });
  if (deletedCount > 0) console.log(`[seed] Removed ${deletedCount} account(s) not on the allowlist.`);

  let created = 0;
  let updated = 0;
  for (const { phone, name, email } of valid) {
    // .lean() returns the raw stored document with no Mongoose schema
    // defaults applied - a role that was never actually written to Mongo
    // reads as genuinely undefined here, so the roleMissing check works.
    const existing = await User.findOne({ phone }).lean();
    if (!existing) {
      await User.create({ phone, name, email, role: 'admin' });
      created += 1;
      continue;
    }

    const roleMissing = existing.role !== 'admin';
    if (existing.name !== name || existing.email !== email || roleMissing) {
      const update = { $set: { name, role: 'admin' } };
      if (email) update.$set.email = email;
      else update.$unset = { email: 1 };
      await User.updateOne({ _id: existing._id }, update);
      updated += 1;
    }
  }
  console.log(`[seed] Allowed users: one-time import from allowedUsers.json - ${created} created, ${updated} updated.`);
}

// Parses the July sheet into the same shape as seedJulyOnly.js, but never
// deletes anything - only returns docs to insert for whatever isn't already
// in the database (see ensurePaymentData below for the actual comparison).
async function parseJulySheet() {
  const members = await readMembers({ includeDeleted: true });
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
      const chargePayments = transactions.map(({ amount, method, dateStr: ds }) => {
        const { year, month, day } = parseSheetDate(ds);
        return { _id: new mongoose.Types.ObjectId(), method, amount, paidAt: randomPaidAt(year, month, day) };
      });
      // A single charge covering everything this placeholder already paid -
      // its amount is the sum of its own payments (rather than looking up a
      // fee that wasn't tracked per-visitor at the time), so it reports as
      // fully Paid, matching how this placeholder has always behaved.
      const chargeAmount = chargePayments.reduce((sum, p) => sum + p.amount, 0);
      visitorDocs.push({
        memberId: viswanathanId,
        name: label,
        email: `visitor.${MONTH_KEY.replace('-', '')}.${visitorRowIndex}@placeholder.bni-agaram.local`,
        phone: '0000000000',
        charges: [
          {
            _id: new mongoose.Types.ObjectId(),
            amount: chargeAmount,
            effectiveFrom: new Date(2026, 6, 1, 9, 0, 0),
            payments: chargePayments,
          },
        ],
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

// One-time import of the July 2026 sheet. It used to re-check on every start
// and re-insert any July record it couldn't find - which would bring back a
// payment or visitor an admin had since edited or deleted. Now it runs at
// most once per database, recorded in SeedState.
const JULY_IMPORT_KEY = 'july-2026-excel-import';

async function ensureJulyPaymentData() {
  if (await SeedState.exists({ key: JULY_IMPORT_KEY })) {
    console.log('[seed] July import: already done on this database - skipped.');
    return;
  }

  // Databases that already received this import before the marker existed:
  // just record it as done, insert nothing.
  const alreadyImported =
    (await Payment.exists({ month: MONTH_KEY })) ||
    (await Visitor.exists({ name: new RegExp(` - ${MONTH_KEY}$`) }).setOptions({ withDeleted: true }));
  if (alreadyImported) {
    await SeedState.create({ key: JULY_IMPORT_KEY, note: 'Existing July data found - marked done without importing.' });
    console.log('[seed] July import: existing July data found - marked as done, nothing re-inserted.');
    return;
  }

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
  await SeedState.create({ key: JULY_IMPORT_KEY, note: 'Imported from the Excel sheet.' });
}

// Backfill for a visitor with no charges at all yet - shouldn't happen via
// createVisitor/ensureJulyPaymentData, which both always seed one charge up
// front, but kept as a defensive safety net. Deliberately ONLY touches a
// visitor whose charges array is genuinely empty, never one that already
// has charges (even just one) - so this can never overwrite or lose real
// payment history already recorded against an existing charge, no matter
// how many times it runs.
async function ensureVisitorCharges() {
  const settings = await getOrCreateSettings();

  const emptyChargeVisitors = await Visitor.find({
    $or: [{ charges: { $exists: false } }, { charges: { $size: 0 } }],
  });
  for (const visitor of emptyChargeVisitors) {
    visitor.charges = [{ amount: settings.visitorFee, effectiveFrom: visitor.createdAt, payments: [] }];
    await visitor.save();
  }

  console.log(`[seed] Visitor charges: backfilled ${emptyChargeVisitors.length} visitor(s) with no charges at all.`);
}

// One-time move from the single fee values in Settings to month-wise fee
// schedules (models/FeeSchedule.js). Built so every month keeps EXACTLY the
// fee it is calculated with today:
//   - member: one row, today's monthlyFee, from the earliest month anything
//     is tracked or paid for (every month so far was calculated at that fee);
//   - visitor/guest: their existing visitorFeeHistory/guestFeeHistory, by
//     month (visitor/guest charges are already fixed on each visitor, so
//     these rows only decide the fee for visitors added from now on), ending
//     on today's value.
// Runs once per database (SeedState) and never touches existing rows.
const FEE_SCHEDULE_KEY = 'fee-schedule-v1';
const MIGRATION_ACTOR = { name: 'System (fee schedule migration)' };

function monthOfDate(date) {
  const d = new Date(date);
  return monthKeyOf(d.getFullYear(), d.getMonth() + 1);
}

function historyToRows(role, history, currentAmount, baseMonth, nowMonth) {
  // Collapse to one amount per month (the last change in a month wins).
  const byMonth = new Map();
  for (const h of [...(history || [])].sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom))) {
    byMonth.set(monthOfDate(h.effectiveFrom), h.amount);
  }
  const rows = [...byMonth.entries()].map(([effectiveMonth, amount]) => ({ role, effectiveMonth, amount }));
  if (!rows.length) rows.push({ role, effectiveMonth: baseMonth, amount: currentAmount });
  // The earliest row covers everything before it too.
  if (rows[0].effectiveMonth > baseMonth) rows[0].effectiveMonth = baseMonth;
  // Today's value must be the fee in effect now, whatever the history says.
  const last = rows[rows.length - 1];
  if (last.amount !== currentAmount) {
    if (last.effectiveMonth === nowMonth) last.amount = currentAmount;
    else rows.push({ role, effectiveMonth: nowMonth, amount: currentAmount });
  }
  return rows;
}

async function ensureFeeSchedule() {
  if (await SeedState.exists({ key: FEE_SCHEDULE_KEY })) return;

  if ((await FeeSchedule.estimatedDocumentCount()) > 0) {
    await SeedState.create({ key: FEE_SCHEDULE_KEY, note: 'Schedule already present.' });
    return;
  }

  const settings = await getOrCreateSettings();
  const now = new Date();
  const nowMonth = monthKeyOf(now.getFullYear(), now.getMonth() + 1);

  const firstPayment = await Payment.findOne({}).sort({ month: 1 }).select('month').lean();
  const firstVisitor = await Visitor.findOne({}).setOptions({ withDeleted: true }).sort({ createdAt: 1 }).select('createdAt').lean();
  const baseMonth = [
    settings.defaultStartMonth,
    settings.columnDisplayStartMonth,
    firstPayment?.month,
    firstVisitor ? monthOfDate(firstVisitor.createdAt) : null,
    nowMonth,
  ]
    .filter(Boolean)
    .sort()[0];

  const rows = [
    { role: 'member', effectiveMonth: baseMonth, amount: settings.monthlyFee },
    ...historyToRows('visitor', settings.visitorFeeHistory, settings.visitorFee, baseMonth, nowMonth),
    ...historyToRows('guest', settings.guestFeeHistory, settings.guestFee, baseMonth, nowMonth),
  ].map((r) => ({ ...r, note: 'Migrated from the previous single fee setting', createdBy: MIGRATION_ACTOR }));

  await FeeSchedule.insertMany(rows);
  await SeedState.create({ key: FEE_SCHEDULE_KEY, note: `Created ${rows.length} fee schedule row(s).` });
  console.log(
    `[fees] Fee schedule created from current settings: ${rows
      .map((r) => `${r.role} ₹${r.amount} from ${r.effectiveMonth}`)
      .join(', ')}`
  );
}

// One-time switch to "a month costs only the fee configured for it" (0 when
// none is configured). Before switching, every month that ALREADY has
// payments recorded - and so is locked - gets its fee saved as it is today
// (from the older from-month-onward schedule), so no paid month's fee or
// balance changes. Months without payments and without a configured fee
// become 0 until a fee is saved for them. Runs once per database.
const EXPLICIT_FEES_KEY = 'monthly-fees-explicit-v1';
const LOCKED_KEEP_ACTOR = { name: 'System (kept – payments recorded)' };

async function ensureLockedMonthFees() {
  if (await SeedState.exists({ key: EXPLICIT_FEES_KEY })) return;

  const schedule = await loadFeeSchedule();
  const paidMonths = { member: new Set(await Payment.distinct('month')), visitor: new Set(), guest: new Set() };
  const paidVisitors = await Visitor.find({ 'charges.payments.0': { $exists: true } })
    .setOptions({ withDeleted: true })
    .select('type createdAt')
    .lean();
  for (const v of paidVisitors) {
    paidMonths[v.type === 'guest' ? 'guest' : 'visitor'].add(monthOfDate(v.createdAt));
  }

  const rows = [];
  for (const [role, months] of Object.entries(paidMonths)) {
    for (const month of months) {
      if (schedule.monthly.has(`${role}|${month}`)) continue; // already configured
      const amount = levelFeeFromSchedule(schedule, role, month);
      if (amount === null) continue;
      rows.push({ role, month, amount, createdBy: LOCKED_KEEP_ACTOR, updatedBy: LOCKED_KEEP_ACTOR });
    }
  }
  if (rows.length) await MonthlyFee.insertMany(rows);
  await SeedState.create({ key: EXPLICIT_FEES_KEY, note: `Kept fees for ${rows.length} month(s) with payments.` });
  console.log(
    `[fees] Unconfigured months now cost 0. Kept the fee of ${rows.length} month(s) that already had payments` +
      (rows.length ? `: ${rows.map((r) => `${r.role} ${r.month} ₹${r.amount}`).join(', ')}` : '.')
  );
}

async function ensureMasterData() {
  await ensureUsers();
  await ensureFeeSchedule();
  await ensureLockedMonthFees();
  await ensureJulyPaymentData();
  await ensureVisitorCharges();
}

module.exports = { ensureMasterData, ensureUsers, ensureJulyPaymentData, ensureVisitorCharges };
