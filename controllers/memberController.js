const { getOrCreateSettings } = require('../utils/getSettings');
const { buildMemberList, buildMemberPendingMonths } = require('../utils/paymentCalculator');
const { findMemberById } = require('../utils/membersData');

const DEFAULT_PAGE_SIZE = 15;

const SORT_MODES = new Set(['name_asc', 'name_desc', 'created_desc', 'created_asc']);

// members.json has no createdAt field - a member's position in that file IS
// its creation order (entries are only ever appended), so "Latest Created"
// sorting is powered by that index rather than a fabricated timestamp.
function sortMembers(members, sort, createdIndexById) {
  const sorted = [...members];
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
  // which sort mode is active - Array.prototype.sort is stable in Node, so
  // splitting the already-sorted array by this one predicate preserves the
  // chosen order within each half rather than re-sorting either of them.
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
      monthlyFee: settings.monthlyFee,
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
    if (!findMemberById(memberId)) {
      return res.status(404).json({ message: 'Member not found' });
    }

    const settings = await getOrCreateSettings();
    const pendingMonths = await buildMemberPendingMonths(memberId, settings);

    res.json({ pendingMonths, monthlyFee: settings.monthlyFee });
  } catch (err) {
    next(err);
  }
}

module.exports = { listMembers, getPendingMonths };
