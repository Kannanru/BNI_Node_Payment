const mongoose = require('mongoose');

// Remembers which one-time data imports have already run on this database,
// so they never run a second time (and never re-create records an admin has
// since edited or deleted).
const seedStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    doneAt: { type: Date, required: true, default: Date.now },
    note: { type: String },
  },
  { versionKey: false }
);

module.exports = mongoose.model('SeedState', seedStateSchema);
