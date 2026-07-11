const { verifyToken } = require('../utils/jwt');

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Missing or invalid Authorization header' });
  }

  try {
    const decoded = verifyToken(token);
    // name is only present on tokens issued after this field was added to
    // the JWT payload - a still-valid older token simply yields undefined,
    // which callers treat as "no Collected By value available".
    req.user = { id: decoded.sub, email: decoded.email, name: decoded.name };
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

module.exports = authMiddleware;
