const User = require('../models/User');

// Gates the Admin Access management endpoints (list current admins, convert
// a member) to callers who currently have role: 'admin' in Mongo - mounted
// after authMiddleware, which is what populates req.user.id in the first
// place. Deliberately re-checks the database on every request rather than
// trusting a role claim embedded in the JWT at sign-in time: admin status
// can change mid-session (a member gets converted, or - in the future - an
// admin gets demoted), and JWTs here live up to JWT_EXPIRES_IN (30 days), so
// a claim baked in at login would otherwise go stale until the holder logs
// in again. A token issued before the role claim even existed decodes with
// no role at all - looking the account up here means that legacy-but-valid
// session still works correctly instead of being rejected until a fresh login.
async function requireAdmin(req, res, next) {
  try {
    const user = await User.findById(req.user.id).select('role').lean();
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireAdmin;
