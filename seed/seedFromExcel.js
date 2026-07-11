// Wipes all Payment and Visitor data and reseeds it from
// "WEEK AFTER WEEK PAYMENTS.xlsx" (the club's real weekly collection sheet),
// replacing the random placeholder data seedPayments.js used to generate.
//
// Only the 'may 26', 'june 26', and 'july 26' sheets are used - they're the
// only ones with a clean, unambiguous per-week CASH/UPI column layout that
// maps directly onto the Payment schema. The older per-week April sheets use
// an inconsistent, method-less "old/cash/gpay/sign" layout and are
// deliberately skipped rather than guessed at.
//
// Two known one-off exceptions in the source data, handled explicitly below:
//   - "SRIDHAR J" in the sheet is "SRIDAR J" in members.json (a spelling
//     variant of the same person, confirmed with the club).
//   - July's 'old' column has a single value (SRIRAM GANESAN, 3400) with no
//     explicit date/method - the only non-empty cell in that column across
//     all three sheets. Treated as a cash payment toward his unpaid May dues
//     (3400 matches May's typical fee, and he has zero recorded May
//     payments), dated to July's first collection day.
//
// Each sheet's "VISITOR" row(s) are aggregate guest-fee totals with no name/
// email/phone/host given, so they can't be tied to a real Visitor record as-
// is. They're seeded as clearly-labelled placeholder Visitor documents
// attached to VISWANATHAN S (the member listed immediately above every
// VISITOR row in all three sheets), so the amounts aren't silently dropped -
// but they are approximations, not real visitor identities.
//
// Usage: node seed/seedFromExcel.js
const path = require('path');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Payment = require('../models/Payment');
const Visitor = require('../models/Visitor');
const Settings = require('../models/Settings');
const { readMembers } = require('../utils/membersData');

const EXCEL_PATH = path.join(__dirname, '..', 'data', 'WEEK AFTER WEEK PAYMENTS.xlsx');

const SHEETS = [
  { name: 'may 26', monthKey: '2026-05' },
  { name: 'june 26', monthKey: '2026-06' },
  { name: 'july 26', monthKey: '2026-07' },
];

// Manual name reconciliation: Excel spelling -> members.json spelling.
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

// "05.05.26" -> {year:2026, month:5, day:5}
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

  const paymentDocs = [];
  const visitorDocs = [];
  const perMonthTotals = new Map();
  const perMemberSeen = new Set();
  let oldColumnHandled = false;

  for (const { name: sheetName, monthKey } of SHEETS) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) throw new Error(`Sheet not found: ${sheetName}`);

    // Column map: col index -> {kind: 'cash'|'upi'|'old', dateStr}
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
        columns.push({ col: c, kind: 'old', dateStr: null });
      }
    }

    let visitorRowIndex = 0;
    // Count visitor rows in this sheet first, for "Visitor 1/2 of N" naming.
    let visitorRowTotal = 0;
    for (let r = 4; r <= ws.rowCount; r++) {
      const nameVal = cellText(ws.getRow(r).getCell(2).value);
      if (nameVal && norm(nameVal) === 'VISITOR') visitorRowTotal += 1;
    }

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
          // Only ever expected once: SRIRAM GANESAN's July 'old' cell.
          if (norm(rawName) !== 'SRIRAM GANESAN' || monthKey !== '2026-07') {
            throw new Error(`Unexpected 'old' column value for "${rawName}" in ${sheetName} - review before seeding`);
          }
          transactions.push({ amount: value, method: 'cash', targetMonthKey: '2026-05', dateStr: '07.07.26' });
          oldColumnHandled = true;
          continue;
        }

        transactions.push({ amount: value, method: kind, targetMonthKey: monthKey, dateStr });
      }

      if (isVisitorRow) {
        visitorRowIndex += 1;
        if (!transactions.length) continue; // e.g. july's second, all-empty VISITOR row
        const label = visitorRowTotal > 1
          ? `Visitor ${visitorRowIndex} - ${monthKey}`
          : `Visitor - ${monthKey}`;
        visitorDocs.push({
          memberId: viswanathanId,
          name: label,
          email: `visitor.${monthKey.replace('-', '')}.${visitorRowIndex}@placeholder.bni-agaram.local`,
          phone: '0000000000',
          createdAtMonthKey: monthKey,
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
      for (const { amount, method, targetMonthKey, dateStr: ds } of transactions) {
        const { year, month, day } = parseSheetDate(ds);
        paymentDocs.push({
          memberId,
          month: targetMonthKey,
          amount,
          method,
          paidAt: randomPaidAt(year, month, day),
        });
        perMonthTotals.set(targetMonthKey, (perMonthTotals.get(targetMonthKey) || 0) + amount);
      }
    }
  }

  if (!oldColumnHandled) {
    console.warn('WARNING: expected SRIRAM GANESAN\'s July "old" cell was not found - data may have changed.');
  }

  const visitorInsertDocs = visitorDocs.map((v) => {
    const { year, month } = parseSheetDate(`01.${v.createdAtMonthKey.split('-')[1]}.${v.createdAtMonthKey.split('-')[0].slice(-2)}`);
    const createdAt = new Date(year, month - 1, 1, 9, 0, 0);
    return {
      memberId: v.memberId,
      name: v.name,
      email: v.email,
      phone: v.phone,
      payments: v.payments,
      createdAt,
      updatedAt: createdAt,
    };
  });

  const DRY_RUN = process.env.DRY_RUN === '1';
  if (DRY_RUN) {
    console.log('*** DRY RUN - no data was deleted or inserted ***');
  } else {
    // Wipe existing data, then update Settings so historical range + display
    // columns start exactly where the real (Excel-backed) data starts.
    await Payment.deleteMany({});
    await Visitor.deleteMany({});
    await Settings.updateOne(
      { key: 'app_settings' },
      {
        $set: {
          defaultStartMonth: '2026-05',
          memberPaymentStartDate: new Date('2026-05-01T00:00:00.000Z'),
          visitorPaymentStartDate: new Date('2026-05-01T00:00:00.000Z'),
        },
      }
    );

    await Payment.insertMany(paymentDocs);
    if (visitorInsertDocs.length) await Visitor.collection.insertMany(visitorInsertDocs);
    console.log('Settings updated: defaultStartMonth=2026-05, member/visitorPaymentStartDate=2026-05-01');
  }

  console.log(`Members matched: ${perMemberSeen.size}`);
  console.log(`Payment transactions inserted: ${paymentDocs.length}`);
  for (const [month, total] of [...perMonthTotals.entries()].sort()) {
    console.log(`  ${month}: total collected = ${total}`);
  }
  console.log(`Visitor placeholder docs inserted: ${visitorInsertDocs.length}`);
  for (const v of visitorInsertDocs) {
    const total = v.payments.reduce((s, p) => s + p.amount, 0);
    console.log(`  ${v.name}: ${total} across ${v.payments.length} txn(s), host=${v.memberId}`);
  }
  console.log('Settings updated: defaultStartMonth=2026-05, member/visitorPaymentStartDate=2026-05-01');

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
