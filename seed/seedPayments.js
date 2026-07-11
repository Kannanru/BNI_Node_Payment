// Seeds January-June payment history for every member, so the Home screen
// shows a realistic mix of Paid/Pending months instead of everything blank.
// Each member/month is independently rolled ~70% likely to be paid; paid
// months get a randomized payment method (with a fake card last-4 when the
// method is card) and a realistic paid-at timestamp within that month.
// Re-running this script is safe and deterministic in effect: every existing
// transaction for the seeded months is cleared first, then regenerated, so
// the result always matches what was just rolled - no leftover duplicates.
// Usage: node seed/seedPayments.js
const connectDB = require('../config/db');
const Payment = require('../models/Payment');
const { readMembers } = require('../utils/membersData');
const { getOrCreateSettings } = require('../utils/getSettings');
const { monthKeyOf } = require('../utils/monthRange');

const SEED_YEAR = 2026;
const SEED_MONTHS = [1, 2, 3, 4, 5, 6];
const METHODS = ['upi', 'card', 'cash'];
const PAID_PROBABILITY = 0.7;

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function randomPaidAt(year, month) {
  const day = 1 + Math.floor(Math.random() * daysInMonth(year, month));
  const hour = 9 + Math.floor(Math.random() * 9); // business hours 9am-6pm
  const minute = Math.floor(Math.random() * 60);
  return new Date(year, month - 1, day, hour, minute);
}

function randomMethod() {
  return METHODS[Math.floor(Math.random() * METHODS.length)];
}

function randomCardLastFour() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

async function main() {
  await connectDB();
  await Payment.syncIndexes();

  const settings = await getOrCreateSettings();
  const members = readMembers();
  const monthKeys = SEED_MONTHS.map((m) => monthKeyOf(SEED_YEAR, m));

  await Payment.deleteMany({ memberId: { $in: members.map((m) => m.id) }, month: { $in: monthKeys } });

  let paidCount = 0;
  let pendingCount = 0;
  const transactions = [];

  for (const member of members) {
    for (const month of SEED_MONTHS) {
      const monthKey = monthKeyOf(SEED_YEAR, month);
      const shouldBePaid = Math.random() < PAID_PROBABILITY;

      if (shouldBePaid) {
        const method = randomMethod();
        transactions.push({
          memberId: member.id,
          month: monthKey,
          method,
          amount: settings.monthlyFee,
          paidAt: randomPaidAt(SEED_YEAR, month),
          ...(method === 'card' ? { cardLastFour: randomCardLastFour() } : {}),
        });
        paidCount += 1;
      } else {
        pendingCount += 1;
      }
    }
  }

  await Payment.insertMany(transactions);

  console.log(`Seeded payments for ${members.length} members across ${SEED_MONTHS.length} months.`);
  console.log(`Paid: ${paidCount}, Pending: ${pendingCount}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
