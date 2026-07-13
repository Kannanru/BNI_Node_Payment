const app = require('./app');
const connectDB = require('./config/db');
const env = require('./config/env');
const Payment = require('./models/Payment');
const { ensureMasterData } = require('./seed/ensureMasterData');
const { readMembers } = require('./utils/membersData');
const { readAllowedUsers } = require('./utils/allowedUsersData');

// Prints exactly what was loaded from allowedUsers.json and the member
// roster file on every boot, by name - not just a count - so a manual edit
// to either file is immediately, visibly confirmed (or its absence is
// immediately obvious) in the same terminal `npm start` runs in, with
// nothing left to take on faith.
function logLoadedMasterData() {
  const users = readAllowedUsers();
  console.log(`[startup] allowedUsers.json: ${users.length} account(s) - ${users.map((u) => u.email).join(', ')}`);

  const members = readMembers();
  const membersSource = env.membersFile || '(default) data/members.json';
  console.log(`[startup] Member roster source: ${membersSource}`);
  console.log(`[startup] Member roster: ${members.length} member(s) loaded:`);
  console.log(members.map((m) => `  ${m.id}: ${m.name}`).join('\n'));
}

async function start() {
  await connectDB();
  // Reconciles indexes with the current schema - needed because Payment
  // dropped its old unique (memberId, month) index in favor of a plain one,
  // now that a month can have multiple payment transactions.
  await Payment.syncIndexes();
  // Idempotent - only inserts whatever master data (login accounts, July
  // payment/visitor records) is actually missing, every time the server
  // starts. See seed/ensureMasterData.js.
  await ensureMasterData();
  logLoadedMasterData();
  app.listen(env.port, () => {
    console.log(`BNI App backend listening on port ${env.port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
