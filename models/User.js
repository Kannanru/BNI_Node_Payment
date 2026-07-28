const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
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
