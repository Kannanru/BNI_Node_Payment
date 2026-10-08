const mongoose = require('mongoose');
const { actorSchema } = require('./Member');

// Append-only history of every change made to members, visitors/guests and
// payments - written by utils/audit.js, never edited or deleted. Powers the
// per-member history timeline (GET /api/members/:memberId/history).
const auditLogSchema = new mongoose.Schema(
  {
    // e.g. 'member.create', 'member.update', 'member.delete',
    // 'payment.create', 'payment.update',
    // 'visitor.create', 'visitor.update', 'visitor.delete',
    // 'visitor_payment.create', 'visitor_payment.update'
    action: { type: String, required: true },
    entityType: { type: String, required: true, enum: ['member', 'payment', 'visitor', 'visitor_payment'] },
    entityId: { type: String, required: true, index: true },
    // The member this event belongs to - every event is filed under a member
    // so their timeline can be read with one query.
    memberId: { type: String, required: true, index: true },
    // Snapshot of the important details at the time (amount, month, method,
    // visitor name, ...), so the event reads correctly even after later edits.
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    // For updates: exactly what changed, old value -> new value.
    changes: {
      type: [
        new mongoose.Schema(
          { field: String, from: mongoose.Schema.Types.Mixed, to: mongoose.Schema.Types.Mixed },
          { _id: false }
        ),
      ],
      default: [],
    },
    actor: { type: actorSchema, default: null },
    at: { type: Date, required: true, default: Date.now, index: true },
  },
  { versionKey: false }
);

auditLogSchema.index({ memberId: 1, at: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
