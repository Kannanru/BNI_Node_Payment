const { getOrCreateSettings } = require('../utils/getSettings');
const { buildMemberList, buildMemberPendingMonths } = require('../utils/paymentCalculator');
const {
  findMemberById,
  findMemberByPhone,
  softDeleteMember,
  addMember,
  updateMemberById,
} = require('../utils/membersData');
const User = require('../models/User');
const { normalizePhone } = require('../utils/phone');
const { actorFrom, diff, logAudit } = require('../utils/audit');
const { buildMemberTimeline } = require('../utils/memberHistory');
const { loadFeeResolver, currentFees } = require('../utils/feeSchedule');

const DEFAULT_PAGE_SIZE = 15;

const SORT_MODES = new Set([
  'name_asc', 'name_desc', 'created_desc', 'created_asc', 'pending_asc', 'pending_desc',
]);

// members.json has no createdAt field - a member's position in that file IS
// its creation order (entries are only ever appended), so "Latest Created"
// sorting is powered by that index rather than a fabricated timestamp.
function sortMembers(members, sort, createdIndexById) {
  const sorted = [...members];

  // pending_asc/pending_desc are a true numeric sort by Total Pending, with
  // no zero-sink override below - the whole point of clicking the Pending
  // header for "smallest to largest" is that a fully-paid (₹0) member is
  // the smallest value and belongs at the very top of ascending order, not
  // pushed to the bottom regardless of sort.
  if (sort === 'pending_asc') {
    sorted.sort((a, b) => a.totalPending - b.totalPending);
    return sorted;
  }
  if (sort === 'pending_desc') {
    sorted.sort((a, b) => b.totalPending - a.totalPending);
    return sorted;
  }

  switch (sort) {
    case 'name_desc':
      sorted.sort((a, b) => b.name.localeCompare(a.name));
      break;
    case 'created_desc':
      sorted.sort((a, b) => createdIndexById.get(b.id) - createdIndexById.get(a.id));
      break;
    case 'created_asc':
      sorted.sort((a, b) => createdIndexById.get(a.id) - createdIndexById.get(b.id));
      break;
    case 'name_asc':
    default:
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
  }

  // Members with a zero Total Amount always sink to the bottom, no matter
  // which of the modes above is active - Array.prototype.sort is stable in
  // Node, so splitting the already-sorted array by this one predicate
  // preserves the chosen order within each half rather than re-sorting
  // either of them.
  const withBalance = sorted.filter((m) => m.totalPending !== 0);
  const zeroBalance = sorted.filter((m) => m.totalPending === 0);
  return [...withBalance, ...zeroBalance];
}

// Supports ?page=&limit=&search=&sort= for the Home screen's paginated,
// searchable, sortable list: search filters by member name first, sort
// orders the full filtered set, then page/limit slice it. total/
// totalPendingSum reflect the filtered set (all matching members), not just
// the current page, so the summary chips stay accurate while only a page of
// rows is returned.
async function listMembers(req, res, next) {
  try {
    const settings = await getOrCreateSettings();
    const allMembers = await buildMemberList(settings);
    const createdIndexById = new Map(allMembers.map((m, index) => [m.id, index]));

    const search = String(req.query.search || '').trim().toLowerCase();
    const filtered = search ? allMembers.filter((m) => m.name.toLowerCase().includes(search)) : allMembers;

    const sort = SORT_MODES.has(req.query.sort) ? req.query.sort : 'name_asc';
    const sorted = sortMembers(filtered, sort, createdIndexById);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE);
    const start = (page - 1) * limit;
    const pageMembers = sorted.slice(start, start + limit);
    const totalPendingSum = sorted.reduce((sum, m) => sum + m.totalPending, 0);

    res.json({
      members: pageMembers,
      page,
      limit,
      total: sorted.length,
      hasMore: start + pageMembers.length < sorted.length,
      totalPendingSum,
      // This month's member fee (each month's own fee is its totalDue).
      monthlyFee: currentFees(await loadFeeResolver(settings)).member,
    });
  } catch (err) {
    next(err);
  }
}

// Powers the "Current Month" payment sheet: every month (across the whole
// Settings.defaultStartMonth-to-current range) that this member still owes
// on, not just the ones visible as Home screen columns.
async function getPendingMonths(req, res, next) {
  try {
    const { memberId } = req.params;
    if (!(await findMemberById(memberId))) {
      return res.status(404).json({ message: 'Member not found' });
    }

    const settings = await getOrCreateSettings();
    const pendingMonths = await buildMemberPendingMonths(memberId, settings);

    res.json({ pendingMonths, monthlyFee: currentFees(await loadFeeResolver(settings)).member });
  } catch (err) {
    next(err);
  }
}

// Soft-deletes a member: they disappear from every list in the app, but the
// member record and every payment and visitor recorded against them stay in
// the database untouched, and the deletion (who, when) goes into their
// history.
async function deleteMember(req, res, next) {
  try {
    const { memberId } = req.params;
    const actor = actorFrom(req);
    const member = await softDeleteMember(memberId, actor);
    if (!member) {
      return res.status(404).json({ message: 'Member not found' });
    }

    await logAudit({
      action: 'member.delete',
      entityType: 'member',
      entityId: memberId,
      memberId,
      details: { name: member.name },
      actor,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// Adds a new member to the roster. Both fields are required by the Add
// Member sheet on the Home screen - name/phone presence and format are
// re-checked here since the client-side Form validation only guards against
// an honest client, not a raw API call. The phone is what Admin Access uses
// as the member's OTP login number if they're ever made an Admin.
async function createMember(req, res, next) {
  try {
    const name = String(req.body.name || '').trim();
    const phone = normalizePhone(req.body.phone);

    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }
    if (!phone) {
      return res.status(400).json({ message: 'A valid 10-digit mobile number is required' });
    }
    const other = await findMemberByPhone(phone);
    if (other) {
      return res.status(409).json({ message: `This mobile number already belongs to ${other.name}` });
    }

    const actor = actorFrom(req);
    const member = await addMember({ name, phone }, actor);
    await logAudit({
      action: 'member.create',
      entityType: 'member',
      entityId: member.id,
      memberId: member.id,
      details: { name: member.name, phone: member.phone },
      actor,
    });
    res.status(201).json({ member });
  } catch (err) {
    next(err);
  }
}

// Renames an existing member. Name-only by design - see
// utils/membersData.js#updateMemberById's doc comment for why email isn't
// accepted here (it's backend-only and never surfaced to the UI, including
// this edit flow).
async function updateMember(req, res, next) {
  try {
    const { memberId } = req.params;
    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }

    // Phone is optional in the request (older app versions send name only),
    // but when sent it must be a valid 10-digit mobile number.
    let phone;
    if (req.body.phone !== undefined) {
      phone = normalizePhone(req.body.phone);
      if (!phone) {
        return res.status(400).json({ message: 'A valid 10-digit mobile number is required' });
      }
      const other = await findMemberByPhone(phone, { excludeId: memberId });
      if (other) {
        return res.status(409).json({ message: `This mobile number already belongs to ${other.name}` });
      }
    }

    const result = await updateMemberById(memberId, { name, phone });
    if (!result) {
      return res.status(404).json({ message: 'Member not found' });
    }

    // A member who is an Admin logs in with their phone - move their login to
    // the new number so changing it here doesn't lock them out.
    const oldPhone = normalizePhone(result.before.phone);
    if (phone && oldPhone && oldPhone !== phone) {
      await User.updateOne({ phone: oldPhone }, { $set: { phone } });
    }

    const changes = diff(result.before, result.after, ['name', 'phone']);
    if (changes.length) {
      await logAudit({
        action: 'member.update',
        entityType: 'member',
        entityId: memberId,
        memberId,
        details: { name: result.after.name },
        changes,
        actor: actorFrom(req),
      });
    }
    res.json({ member: result.after });
  } catch (err) {
    next(err);
  }
}

// The member's complete history in one response: their details (who created
// them and when), every payment (month, amount, method, who recorded it),
// every still-pending month, and a newest-first timeline of everything that
// ever happened to them (see utils/memberHistory.js).
async function getMemberHistory(req, res, next) {
  try {
    const { memberId } = req.params;
    const settings = await getOrCreateSettings();
    const history = await buildMemberTimeline(memberId, settings);
    if (!history) {
      return res.status(404).json({ message: 'Member not found' });
    }
    res.json(history);
  } catch (err) {
    next(err);
  }
}

module.exports = { listMembers, getPendingMonths, deleteMember, createMember, updateMember, getMemberHistory };
