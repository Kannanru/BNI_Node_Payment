const AuditLog = require('../models/AuditLog');

// The logged-in admin making the request (see authMiddleware), in the shape
// stored on records and audit events.
function actorFrom(req) {
  if (!req || !req.user) return null;
  return { id: req.user.id, name: req.user.name, phone: req.user.phone };
}

// Lists the fields whose value differs between [before] and [after] as
// { field, from, to } - only the fields named in [fields] are compared.
function diff(before, after, fields) {
  const changes = [];
  for (const field of fields) {
    const from = before[field] === undefined ? null : before[field];
    const to = after[field] === undefined ? null : after[field];
    if (String(from) !== String(to)) changes.push({ field, from, to });
  }
  return changes;
}

// Records one history event. Never throws: a failure to write history is
// logged but must not undo or fail the change the admin just made.
async function logAudit({ action, entityType, entityId, memberId, details = {}, changes = [], actor = null, at }) {
  try {
    await AuditLog.create({
      action,
      entityType,
      entityId: String(entityId),
      memberId,
      details,
      changes,
      actor,
      ...(at ? { at } : {}),
    });
  } catch (err) {
    console.error(`[audit] Failed to record ${action} for ${entityType} ${entityId}: ${err.message}`);
  }
}

module.exports = { actorFrom, diff, logAudit };
