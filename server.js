const app = require('./app');
const connectDB = require('./config/db');
const env = require('./config/env');
const Payment = require('./models/Payment');

async function start() {
  await connectDB();
  // Reconciles indexes with the current schema - needed because Payment
  // dropped its old unique (memberId, month) index in favor of a plain one,
  // now that a month can have multiple payment transactions.
  await Payment.syncIndexes();
  app.listen(env.port, () => {
    console.log(`BNI App backend listening on port ${env.port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
