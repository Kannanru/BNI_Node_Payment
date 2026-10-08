const mongoose = require('mongoose');

// Who performed an action - copied onto the record at the time (not just a
// reference), so the name stays readable in history even if that admin
// account is later removed.
const actorSchema = new mongoose.Schema(
  {
    id: { type: String },
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
  },
  { _id: false }
);

// The member roster. Lives in MongoDB (it used to be data/members.json) so
// every create/edit/delete is stored and tracked on the server. Members are
// never removed from the database: deleting one only marks it isDeleted, which
// hides it from the app while keeping it - and everything recorded against
// it - for the record.
const memberSchema = new mongoose.Schema(
  {
    // "m<number>" - the id Payment.memberId / Visitor.memberId refer to. Kept
    // in this format (and never reused, even after a delete) so every
    // existing payment and visitor still points at the right member.
    memberId: { type: String, required: true, unique: true, trim: true },
    // Numeric part of memberId - creation order for "Latest Created" sorting.
    seq: { type: Number, required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true },
    createdBy: { type: actorSchema, default: null },
    // True for members imported from data/members.json when this moved to the
    // database - their real creation date/creator was never recorded.
    importedFromFile: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date },
    deletedBy: { type: actorSchema, default: undefined },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Member', memberSchema);
module.exports.actorSchema = actorSchema;
