// Syncs the login accounts with config/allowedUsers.json on demand - the
// same reconciliation `npm start` already runs on every boot (see
// ensureMasterData.js's ensureUsers). The app has no signup UI, so the
// allowlist is the only way accounts get created. Accounts log in with a
// mobile number + SMS OTP; there are no passwords.
// Usage: node seed/seedUsers.js
const connectDB = require('../config/db');
const { ensureUsers } = require('./ensureMasterData');

async function main() {
  await connectDB();
  await ensureUsers();
  console.log('Done syncing login accounts.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
