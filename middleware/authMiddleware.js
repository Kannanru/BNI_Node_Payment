const { verifyToken } = require('../utils/jwt');

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Missing or invalid Authorization header' });
  }

  try {
    const decoded = verifyToken(token);
    // name/role are only present on tokens issued after each field was added
    // to the JWT payload - a still-valid older token simply yields undefined
    // for whichever field postdates it, which callers treat as "no value
    // available". role in particular is informational only here (e.g. for a
    // client-side UI hint) - requireAdmin never trusts this claim, it always
    // re-checks the account's current role in the database instead.
    req.user = { id: decoded.sub, email: decoded.email, name: decoded.name, role: decoded.role };
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

module.exports = authMiddleware;
