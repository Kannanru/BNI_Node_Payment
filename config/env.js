require('dotenv').config();

const env = {
  port: process.env.PORT || 4000,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bni_app',
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  // Optional local-machine override for where the member roster is read
  // from (see utils/membersData.js). Left unset, it defaults to
  // data/members.json inside this repo - the portable, production-safe
  // path. Set MEMBERS_FILE in .env (gitignored, never committed) to point
  // at a different file on your own machine instead, e.g. a file you
  // already keep open and edit in your editor.
  membersFile: process.env.MEMBERS_FILE || null,
  // Saptel DLT SMS settings for sending login OTPs (see utils/sms.js).
  // Leave them unset to run in dev mode, where the code is printed in the
  // server terminal instead of being texted.
  saptelApiKey: process.env.SAPTEL_API_KEY || null,
  saptelSender: process.env.SAPTEL_SENDER || null,
  saptelRouteType: process.env.SAPTEL_ROUTE_TYPE || '1',
  saptelTid: process.env.SAPTEL_TID || null,
  saptelTemplate: process.env.SAPTEL_TEMPLATE || null,
};

module.exports = env;
