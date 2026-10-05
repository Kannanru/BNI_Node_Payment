const mongoose = require('mongoose');

// One pending login code per phone number. Requesting a new code overwrites
// the previous one, so only the most recently sent SMS is ever valid. The
// code itself is never stored - only a hash of it (see authController.js).
const otpSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    codeHash: { type: String, required: true },
    // Mongo's TTL monitor deletes the document once this time passes, so an
    // expired code disappears on its own even if nobody ever tries it.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true },
    // Rolling one-hour send budget per number, so the Send OTP button can't
    // be used to run up the MSG91 bill or spam someone's phone.
    sendWindowStart: { type: Date, required: true },
    sendCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Otp', otpSchema);
