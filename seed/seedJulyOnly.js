// Wipes ALL Payment and Visitor data and reseeds ONLY July 2026 from
// "WEEK AFTER WEEK PAYMENTS.xlsx" - the app now tracks the current month
// only (see paymentCalculator.js's buildMemberList/buildMemberPendingMonths),
// so May and June payment/visitor records were deliberately removed and are
// not recreated here.
//
// The July sheet's 'old' column (a single cell: SRIRAM GANESAN, 3400) refers
// to a pre-July due and is deliberately SKIPPED - it has no July-appropriate
// month to attach to now that only July is tracked.
//
// "SRIDHAR J" in the sheet is "SRIDAR J" in members.json (a spelling variant
// of the same person, confirmed with the club).
//
// Usage: node seed/seedJulyOnly.js
const path = require('path');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
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

async function main() {
  await connectDB();
  await Payment.syncIndexes();

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
  let skippedOldCell = null;
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
  const perMemberSeen = new Set();
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
      if (kind === 'old') {
        skippedOldCell = { name: rawName, value };
        continue; // pre-July due - out of scope now that only July is tracked
      }
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
        // insertMany() below uses the raw driver (bypassing Mongoose) so
        // createdAt/updatedAt can be backdated - but that also means
        // Mongoose's automatic subdocument _id assignment never runs, so
        // each payment subdocument needs its _id set explicitly here or the
        // API omits "id" entirely for it (see mapPaymentEntry), which the
        // Flutter client's PaymentEntry.fromJson cannot parse.
        payments: transactions.map(({ amount, method, dateStr: ds }) => {
          const { year, month, day } = parseSheetDate(ds);
          return { _id: new mongoose.Types.ObjectId(), method, amount, paidAt: randomPaidAt(year, month, day) };
        }),
      });
      continue;
    }

    const memberId = resolveMemberId(rawName);
    perMemberSeen.add(memberId);
    for (const { amount, method, dateStr: ds } of transactions) {
      const { year, month, day } = parseSheetDate(ds);
      paymentDocs.push({
        memberId,
        month: MONTH_KEY,
        amount,
        method,
        paidAt: randomPaidAt(year, month, day),
      });
    }
  }

  await Payment.deleteMany({});
  await Visitor.deleteMany({});
  await Payment.insertMany(paymentDocs);

  const createdAt = new Date(2026, 6, 1, 9, 0, 0); // July 1, 2026
  const visitorInsertDocs = visitorDocs.map((v) => ({ ...v, createdAt, updatedAt: createdAt }));
  if (visitorInsertDocs.length) await Visitor.collection.insertMany(visitorInsertDocs);

  const totalAmount = paymentDocs.reduce((s, p) => s + p.amount, 0);
  console.log(`Members matched: ${perMemberSeen.size}`);
  console.log(`July payment transactions inserted: ${paymentDocs.length}, total = ${totalAmount}`);
  console.log(`Visitor placeholder docs inserted: ${visitorInsertDocs.length}`);
  for (const v of visitorInsertDocs) {
    const total = v.payments.reduce((s, p) => s + p.amount, 0);
    console.log(`  ${v.name}: ${total} across ${v.payments.length} txn(s), host=${v.memberId}`);
  }
  if (skippedOldCell) {
    console.log(`Skipped 'old' column cell (pre-July due, out of scope): ${skippedOldCell.name} = ${skippedOldCell.value}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
