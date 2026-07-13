// Seeds the fixed set of employee accounts allowed to log in (see
// config/allowedUsers.json). The app has no signup UI, so this is the only
// way accounts get created. Each account's password is set explicitly in
// allowedUsers.json and stored bcrypt-hashed here. Any User document whose
// email is not in the allowlist is removed.
// Usage: node seed/seedUsers.js
const bcrypt = require('bcryptjs');
const connectDB = require('../config/db');
const User = require('../models/User');
const { readAllowedUsers } = require('../utils/allowedUsersData');

async function main() {
  await connectDB();

  const ALLOWED_USERS = readAllowedUsers();
  const allowedEmails = ALLOWED_USERS.map((u) => u.email);
  const { deletedCount } = await User.deleteMany({ email: { $nin: allowedEmails } });
  if (deletedCount > 0) {
    console.log(`Removed ${deletedCount} account(s) not on the allowlist.`);
  }

  for (const { email, name, password } of ALLOWED_USERS) {
    const passwordHash = await bcrypt.hash(password, 10);

    await User.findOneAndUpdate(
      { email },
      { email, name, passwordHash },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    console.log(`Seeded user: ${email} (password: ${password})`);
  }

  console.log('Done seeding employee accounts.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
