const crypto = require('crypto');
const env = require('../config/env');
const User = require('../models/User');
const Otp = require('../models/Otp');
const { signToken } = require('../utils/jwt');
const { readAllowedUsers } = require('../utils/allowedUsersData');
const { normalizePhone } = require('../utils/phone');
const { sendOtpSms } = require('../utils/sms');

const OTP_LENGTH = 6;
// A code must be entered within 60 seconds of being sent - after that it's
// rejected (right or wrong) and a new one has to be requested.
const OTP_EXPIRY_SECONDS = 60;
const MAX_VERIFY_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 5;

// Only a keyed hash of the code is ever stored, so reading the database
// doesn't reveal any live login code.
function hashCode(phone, code) {
  return crypto.createHmac('sha256', env.jwtSecret).update(`${phone}:${code}`).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

const NOT_REGISTERED_MESSAGE = 'This mobile number is not registered. Please contact the admin.';

// Only numbers listed in allowedUsers.json may ever receive a code or a
// token, even if a stray User document exists in the database. Read fresh
// on every call (not cached at module load).
function isAllowedPhone(phone) {
  return readAllowedUsers().some((u) => normalizePhone(u.phone) === phone);
}

// Step 1 of login: texts a 6-digit code to an allowlisted mobile number. An
// unlisted number gets an error and no SMS is sent (so no credit is spent).
// Wrong-number/limit responses are 4xx but never 401 - the Flutter client
// treats a 401 as an expired session and force-navigates to Login.
async function requestOtp(req, res, next) {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({ message: 'Enter a valid 10-digit mobile number' });
    }

    if (!isAllowedPhone(phone) || !(await User.exists({ phone }))) {
      return res.status(404).json({ message: NOT_REGISTERED_MESSAGE });
    }

    const now = new Date();
    const existing = await Otp.findOne({ phone });

    if (existing) {
      const secondsSinceLast = (now - existing.lastSentAt) / 1000;
      if (secondsSinceLast < RESEND_COOLDOWN_SECONDS) {
        const wait = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLast);
        return res.status(429).json({ message: `Please wait ${wait}s before requesting a new OTP`, retryAfter: wait });
      }
    }

    const windowStillOpen = existing && now - existing.sendWindowStart < 60 * 60 * 1000;
    const sendCount = windowStillOpen ? existing.sendCount : 0;
    if (sendCount >= MAX_SENDS_PER_HOUR) {
      return res.status(429).json({ message: 'Too many OTP requests. Please try again in an hour.' });
    }

    const code = generateCode();
    try {
      await sendOtpSms(phone, code);
    } catch (err) {
      return res.status(502).json({ message: 'Could not send the OTP SMS. Please try again.' });
    }

    await Otp.findOneAndUpdate(
      { phone },
      {
        $set: {
          codeHash: hashCode(phone, code),
          expiresAt: new Date(now.getTime() + OTP_EXPIRY_SECONDS * 1000),
          attempts: 0,
          lastSentAt: now,
          sendWindowStart: windowStillOpen ? existing.sendWindowStart : now,
          sendCount: sendCount + 1,
        },
      },
      { upsert: true }
    );

    res.json({ success: true, resendAfter: RESEND_COOLDOWN_SECONDS, expiresIn: OTP_EXPIRY_SECONDS });
  } catch (err) {
    next(err);
  }
}

// Step 2 of login: checks the code and, if it matches, issues the JWT. A
// code is single-use - it's deleted the moment it succeeds, and after
// MAX_VERIFY_ATTEMPTS wrong guesses it's deleted too, forcing a new SMS.
async function verifyOtp(req, res, next) {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.otp || '').trim();
    if (!phone || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: 'Enter the 6-digit OTP' });
    }

    const otp = await Otp.findOne({ phone });
    if (!otp || otp.expiresAt < new Date()) {
      return res.status(400).json({ message: 'OTP time expired. Please tap Resend OTP to get a new code.' });
    }

    const expected = Buffer.from(otp.codeHash, 'hex');
    const actual = Buffer.from(hashCode(phone, code), 'hex');
    if (!crypto.timingSafeEqual(expected, actual)) {
      otp.attempts += 1;
      if (otp.attempts >= MAX_VERIFY_ATTEMPTS) {
        await Otp.deleteOne({ _id: otp._id });
        return res.status(400).json({ message: 'Too many wrong attempts. Please request a new OTP.' });
      }
      await otp.save();
      const left = MAX_VERIFY_ATTEMPTS - otp.attempts;
      return res.status(400).json({ message: `Incorrect OTP. ${left} attempt(s) left.` });
    }

    await Otp.deleteOne({ _id: otp._id });

    // Re-checked here too: the number could have been removed from the
    // allowlist between sending the code and entering it.
    const user = isAllowedPhone(phone) ? await User.findOne({ phone }) : null;
    if (!user) {
      return res.status(404).json({ message: NOT_REGISTERED_MESSAGE });
    }

    const token = signToken({ sub: user.id, phone: user.phone, email: user.email, name: user.name, role: user.role });

    res.json({
      token,
      user: { id: user.id, name: user.name, phone: user.phone, email: user.email || null, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { requestOtp, verifyOtp };
