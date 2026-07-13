const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { signToken } = require('../utils/jwt');
const { readAllowedUsers } = require('../utils/allowedUsersData');

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

    const token = signToken({ sub: user.id, email: user.email, name: user.name });

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { login };
