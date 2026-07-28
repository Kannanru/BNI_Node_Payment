const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { signToken } = require('../utils/jwt');
const { readAllowedUsers, updateAllowedUserPassword } = require('../utils/allowedUsersData');

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Defense in depth: only the accounts currently listed in
    // allowedUsers.json may ever receive a token, even if a stray User
    // document exists in the database. Read fresh on every login (not
    // cached at module load) so an email added to the JSON file is
    // recognized immediately, with no server restart required for this
    // check specifically - though the account still needs a matching User
    // document (see ensureMasterData.js) to actually pass the password
    // check below.
    const allowedEmails = new Set(readAllowedUsers().map((u) => u.email));
    if (!allowedEmails.has(normalizedEmail)) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = signToken({ sub: user.id, email: user.email, name: user.name, role: user.role });

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

// Powers the Change Password sheet's first step: confirms the caller knows
// their current password before the New/Confirm Password fields ever appear,
// without changing anything yet. Same 400-not-401 reasoning as
// changePassword below - a wrong-password response must never look like an
// expired session to ApiClient's interceptor.
async function verifyPassword(req, res, next) {
  try {
    const { currentPassword } = req.body;
    if (!currentPassword) {
      return res.status(400).json({ message: 'Current password is required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const matches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!matches) {
      return res.status(400).json({ message: 'Old password is incorrect' });
    }

    res.json({ valid: true });
  } catch (err) {
    next(err);
  }
}

// Requires authMiddleware (req.user set from the caller's own JWT) - a user
// can only ever change their own password, never anyone else's. Responds
// 400 (not 401) for a wrong current password: ApiClient's interceptor
// treats any non-login 401 as an expired session and force-clears the
// token/navigates to Login, which would blow away this dialog before the
// "Old password is incorrect" message ever reached the user. Re-checks
// currentPassword independently here even though the Change Password sheet
// already called verifyPassword earlier in the same flow - this is the call
// that actually changes the account, so it never trusts client-side state
// alone for that.
async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const currentMatches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!currentMatches) {
      return res.status(400).json({ message: 'Old password is incorrect' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();

    // Keep allowedUsers.json's plaintext copy in sync - see
    // updateAllowedUserPassword's doc comment for why this matters.
    updateAllowedUserPassword(user.email, newPassword);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, verifyPassword, changePassword };
