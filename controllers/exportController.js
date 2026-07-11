const ExcelJS = require('exceljs');
const { getOrCreateSettings } = require('../utils/getSettings');
const { buildMemberExportSheet, MONTH_GROUP_HEADERS, VISITOR_GROUP_HEADERS } = require('../utils/exportBuilder');

const MONTH_KEY_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const LEAD_COLUMN_COUNT = 5; // Member Name, Total Expected/Paid/Pending, Overall Status

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

module.exports = { exportReport };
