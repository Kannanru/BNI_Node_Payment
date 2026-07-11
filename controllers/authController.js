const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { signToken } = require('../utils/jwt');
const { ALLOWED_USERS } = require('../config/allowedUsers');

const ALLOWED_EMAILS = new Set(ALLOWED_USERS.map((u) => u.email));

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Defense in depth: only the seeded employee accounts may ever receive a
    // token, even if a stray User document exists in the database.
    if (!ALLOWED_EMAILS.has(normalizedEmail)) {
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
