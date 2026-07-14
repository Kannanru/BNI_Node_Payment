const ExcelJS = require('exceljs');
const { getOrCreateSettings } = require('../utils/getSettings');
const {
  buildMemberExportSheet,
  buildTransactionExportSheet,
  MONTH_GROUP_HEADERS,
  VISITOR_GROUP_HEADERS,
} = require('../utils/exportBuilder');

const MONTH_KEY_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const LEAD_COLUMN_COUNT = 5; // Member Name, Total Expected/Paid/Pending, Overall Status

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB0122A' } };
const BAND_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F3F4' } };
const THIN_GREY = { style: 'thin', color: { argb: 'FFD9D9D9' } };
const CELL_BORDER = { top: THIN_GREY, left: THIN_GREY, bottom: THIN_GREY, right: THIN_GREY };

// Turns a bare ExcelJS table (plain header row + data rows) into one with
// visible breathing room between cells: a bold white-on-red header row,
// thin grey borders on every cell, light banding on alternate data rows,
// and right-aligned/comma-formatted numbers - instead of default Excel
// styling where every cell touches its neighbour with no visual separation.
function styleReportSheet(sheet, { amountColumns = [] } = {}) {
  const headerRow = sheet.getRow(1);
  headerRow.height = 24;
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = CELL_BORDER;
  });

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.height = 20;
    const isBanded = rowNumber % 2 === 0;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.border = CELL_BORDER;
      cell.alignment = {
        vertical: 'middle',
        horizontal: amountColumns.includes(colNumber) ? 'right' : 'left',
        wrapText: false,
      };
      if (isBanded) cell.fill = BAND_FILL;
      if (amountColumns.includes(colNumber)) cell.numFmt = '#,##0';
    });
  }
}

// GET /api/export?from=YYYY-MM&to=YYYY-MM - "from"/"to" are the From Month /
// To Month selected on the Export screen, inclusive on both ends. One row
// per member; every month in range and every relevant visitor gets its own
// group of columns on that row (see exportBuilder.js).
async function exportReport(req, res, next) {
  try {
    const { from, to } = req.query;
    if (!MONTH_KEY_REGEX.test(from || '') || !MONTH_KEY_REGEX.test(to || '')) {
      return res.status(400).json({ message: 'from and to query params (YYYY-MM) are required' });
    }
    if (from > to) {
      return res.status(400).json({ message: 'Invalid month range: from must be <= to' });
    }

    const settings = await getOrCreateSettings();
    // headers/rows already end with a per-member "Processed By" column
    // (the actual login user(s) who recorded THAT member's payments in
    // range) - not the account running this export, which is a different,
    // file-level fact unrelated to who processed any given payment.
    const { headers, rows, monthGroupCount, visitorGroupCount } = await buildMemberExportSheet({
      fromMonth: from,
      toMonth: to,
      settings,
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'BNI App';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Payment Report');
    sheet.columns = headers.map((header) => ({
      header,
      width: header.length > 18 ? 22 : 16,
    }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: headers.length },
    };

    for (const row of rows) sheet.addRow(row);

    // A second header row of group labels ("Jul/26", "Visitor 1", ...) above
    // the per-field headers, so it's clear at a glance which columns belong
    // together - inserted after the data so it doesn't shift row-array
    // positions while rows are being added.
    const groupRow = ['', '', '', '', ''];
    const monthLabels = headers.slice(LEAD_COLUMN_COUNT, LEAD_COLUMN_COUNT + monthGroupCount * MONTH_GROUP_HEADERS.length);
    for (let i = 0; i < monthGroupCount; i += 1) {
      const label = monthLabels[i * MONTH_GROUP_HEADERS.length].replace(` ${MONTH_GROUP_HEADERS[0]}`, '');
      groupRow.push(label, ...Array(MONTH_GROUP_HEADERS.length - 1).fill(''));
    }
    for (let i = 1; i <= visitorGroupCount; i += 1) {
      groupRow.push(`Visitor ${i}`, ...Array(VISITOR_GROUP_HEADERS.length - 1).fill(''));
    }
    groupRow.push(''); // trailing Processed By column - not part of any group
    sheet.insertRow(2, groupRow);
    sheet.getRow(2).font = { bold: true, italic: true };
    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }];

    const fileName = `bni-payment-report_${from}_to_${to}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
}

// GET /api/export/by-date?from=YYYY-MM-DD&to=YYYY-MM-DD - a single date is
// selected by passing the same value for from and to. Unlike exportReport,
// this is a flat transaction list (one row per payment) restricted to the
// exact instant range, so a range narrower than a full month only includes
// what was actually paid during it.
async function exportTransactionsByDate(req, res, next) {
  try {
    const { from, to } = req.query;
    if (!DATE_REGEX.test(from || '') || !DATE_REGEX.test(to || '')) {
      return res.status(400).json({ message: 'from and to query params (YYYY-MM-DD) are required' });
    }
    if (from > to) {
      return res.status(400).json({ message: 'Invalid date range: from must be <= to' });
    }

    const fromDate = new Date(`${from}T00:00:00`);
    const toDate = new Date(`${to}T23:59:59.999`);

    const { headers, rows } = await buildTransactionExportSheet({ fromDate, toDate });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'BNI App';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Payment Report');
    const columnWidths = { 'Member Name': 26, 'Visitor Name': 22, 'Date/Time': 20, 'Collected By': 18, 'Remarks': 30 };
    sheet.columns = headers.map((header) => ({
      header,
      width: columnWidths[header] || 16,
    }));
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: headers.length },
    };

    for (const row of rows) sheet.addRow(row);
    styleReportSheet(sheet, { amountColumns: [headers.indexOf('Amount') + 1] });

    const fileName = from === to ? `bni-payment-report_${from}.xlsx` : `bni-payment-report_${from}_to_${to}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
}

module.exports = { exportReport, exportTransactionsByDate };
