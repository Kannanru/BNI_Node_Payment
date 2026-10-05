const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Login identity: a bare 10-digit mobile number (see utils/phone.js).
    // Accounts sign in with an SMS OTP sent to this number - there are no
    // passwords.
    phone: { type: String, required: true, unique: true, trim: true },
    // Optional, informational only (stamped onto payments/visitors as
    // recordedByEmail when present). Never used to log in.
    email: { type: String, lowercase: true, trim: true },
    // Every account created through any current pathway (config/allowedUsers.json
    // seeding, or converting a member via the Admin Access screen) grants full
    // app access, so 'admin' is the only role that exists today - this field
    // exists so the Admin Access feature has something concrete to gate on and
    // so a future non-admin login pathway has somewhere to record that.
    role: { type: String, enum: ['admin'], default: 'admin' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
