// Logs every request with its response time and status code, and separately
// flags any request that takes longer than SLOW_REQUEST_MS - so a hang or
// slowdown anywhere in the stack (DB, bcrypt, JWT signing, etc.) shows up
// immediately in the server logs instead of only being visible as a client-
// side timeout with no server-side trace.
const SLOW_REQUEST_MS = 1000;

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs.toFixed(1)}ms)`;

    if (durationMs > SLOW_REQUEST_MS) {
      console.warn(`[SLOW] ${line}`);
    } else {
      console.log(line);
    }
  });
  

  next();
}

module.exports = requestLogger;
