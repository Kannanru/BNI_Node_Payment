const app = require('./app');
const connectDB = require('./config/db');
const env = require('./config/env');
const Payment = require('./models/Payment');
const { ensureMasterData } = require('./seed/ensureMasterData');
const { readMembers, importMembersFromFileIfEmpty } = require('./utils/membersData');
const { readAllowedUsers } = require('./utils/allowedUsersData');
const { normalizePhone, maskPhone } = require('./utils/phone');
const { isSmsConfigured } = require('./utils/sms');

// Prints exactly what was loaded from allowedUsers.json and the member
// roster file on every boot, by name - not just a count - so a manual edit
// to either file is immediately, visibly confirmed (or its absence is
// immediately obvious) in the same terminal `npm start` runs in, with
// nothing left to take on faith.
async function logLoadedMasterData() {
  const users = readAllowedUsers();
  const summary = users.map((u) => `${u.name} (${normalizePhone(u.phone) ? maskPhone(normalizePhone(u.phone)) : 'NO VALID PHONE'})`);
  console.log(`[startup] allowedUsers.json: ${users.length} account(s) - ${summary.join(', ')}`);
  console.log(
    isSmsConfigured()
      ? '[startup] Login OTP: sending real SMS via Saptel.'
      : '[startup] Login OTP: DEV MODE - Saptel not configured, OTPs are printed in this terminal.'
  );

  const members = await readMembers();
  console.log('[startup] Member roster source: MongoDB (members collection)');
  console.log(`[startup] Member roster: ${members.length} active member(s):`);
  console.log(members.map((m) => `  ${m.id}: ${m.name}`).join('\n'));
}

async function start() {
  await connectDB();
  // Reconciles indexes with the current schema - needed because Payment
  // dropped its old unique (memberId, month) index in favor of a plain one,
  // now that a month can have multiple payment transactions.
  await Payment.syncIndexes();
  // First start after the move to MongoDB: copies data/members.json into the
  // members collection once (does nothing once members exist in the DB).
  await importMembersFromFileIfEmpty();
  // Idempotent - only inserts whatever master data (login accounts, the
  // one-time July payment/visitor import) is actually missing. See
  // seed/ensureMasterData.js.
  await ensureMasterData();
  await logLoadedMasterData();
  app.listen(env.port, () => {
    console.log(`BNI App backend listening on port ${env.port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
