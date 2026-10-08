// Manage Allowed Users (admin login accounts) directly in THIS server's
// database - the only place they live. Works the same on a local machine and
// on production; nothing is written to any file, so it never travels with a
// code deploy. (Members can also be given/removed Admin access from the app:
// Settings > Admin Access.)
//
// Usage:
//   npm run admins -- list
//   npm run admins -- add 9876543210 "Full Name"
//   npm run admins -- remove 9876543210
const connectDB = require('../config/db');
const mongoose = require('mongoose');
const User = require('../models/User');
const { normalizePhone } = require('../utils/phone');

async function main() {
  const [command, rawPhone, ...nameParts] = process.argv.slice(2);
  await connectDB();

  if (command === 'list' || !command) {
    const users = await User.find({ role: 'admin' }).sort({ name: 1 }).lean();
    console.log(`${users.length} allowed user(s):`);
    for (const u of users) console.log(`  ${u.phone}  ${u.name}`);
  } else if (command === 'add') {
    const phone = normalizePhone(rawPhone);
    const name = nameParts.join(' ').trim();
    if (!phone || !name) throw new Error('Usage: npm run admins -- add 9876543210 "Full Name"');
    const existing = await User.findOne({ phone });
    await User.updateOne({ phone }, { $set: { phone, name, role: 'admin' } }, { upsert: true });
    console.log(`${existing ? 'Updated' : 'Added'} allowed user: ${phone} ${name}`);
  } else if (command === 'remove') {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw new Error('Usage: npm run admins -- remove 9876543210');
    const { deletedCount } = await User.deleteOne({ phone });
    console.log(deletedCount ? `Removed allowed user ${phone}` : `No allowed user with ${phone}`);
  } else {
    throw new Error(`Unknown command "${command}" - use list, add or remove`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
