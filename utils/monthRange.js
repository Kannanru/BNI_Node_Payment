const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const SHORT_MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// "Jul/26" - short month name + last two digits of the year, per the Home
// screen's month column header format.
function shortMonthYearLabel(month, year) {
  return `${SHORT_MONTH_LABELS[month - 1]}/${String(year).slice(-2)}`;
}

function parseMonthKey(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return { year, month }; // month is 1-12
}

function monthKeyOf(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// Builds ["YYYY-MM", ...] inclusive, from startMonthKey through the current calendar month.
// If startMonthKey is in the future relative to now, returns just the start month.
function buildMonthRange(startMonthKey, now = new Date()) {
  const { year: startYear, month: startMonth } = parseMonthKey(startMonthKey);
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const months = [];
  let year = startYear;
  let month = startMonth;

  const startIndex = startYear * 12 + startMonth;
  const endIndex = currentYear * 12 + currentMonth;
  const lastIndex = Math.max(startIndex, endIndex);

  while (year * 12 + month <= lastIndex) {
    months.push({ key: monthKeyOf(year, month), label: MONTH_LABELS[month - 1] });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

// Builds the Home screen's month column window: the current calendar month
// first, followed by the `historyMonths` months immediately before it in
// reverse-chronological order - a pure rolling window with no dependency on
// the calendar year or Settings.defaultStartMonth. On the 1st of every
// month this shifts by exactly one position on its own: the new month
// becomes the first column (labelled literally "This Month") and what
// was previously the current month slides into the next column with its own
// short "Mon/YY" label, and so on, with the oldest column falling off the
// end - no manual update ever required.
function buildCurrentMonthAndHistory(now = new Date(), historyMonths = 1) {
  let year = now.getFullYear();
  let month = now.getMonth() + 1;

  const months = [];
  for (let i = 0; i <= historyMonths; i += 1) {
    const label = i === 0 ? 'This Month' : shortMonthYearLabel(month, year);
    months.push({ key: monthKeyOf(year, month), label });
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  return months;
}

// Builds ["YYYY-MM", ...] inclusive, strictly between the two given keys -
// unlike buildMonthRange, this never extends past toKey towards the current
// calendar month, which matters for a report whose "To Month" is in the
// past (buildMonthRange would otherwise keep going through "now").
function buildMonthRangeBetween(fromKey, toKey) {
  const { year: startYear, month: startMonth } = parseMonthKey(fromKey);
  const { year: endYear, month: endMonth } = parseMonthKey(toKey);

  const startIndex = startYear * 12 + startMonth;
  const endIndex = endYear * 12 + endMonth;
  const lastIndex = Math.max(startIndex, endIndex);

  const months = [];
  let year = startYear;
  let month = startMonth;
  while (year * 12 + month <= lastIndex) {
    months.push({ key: monthKeyOf(year, month), label: MONTH_LABELS[month - 1] });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

module.exports = {
  buildMonthRange,
  buildMonthRangeBetween,
  buildCurrentMonthAndHistory,
  MONTH_LABELS,
  SHORT_MONTH_LABELS,
  shortMonthYearLabel,
  parseMonthKey,
  monthKeyOf,
};
