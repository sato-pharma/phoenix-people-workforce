/**
 * Phoenix Workforce — CV Lifecycle live Google Sheet
 * ==================================================================================
 * The full life of every CV, from reaching Phoenix to sitting in the owner's Google Drive, in a
 * sheet that fills itself. Three tabs:
 *
 *   Summary          — the headline numbers, and the one caveat nobody should miss.
 *   Daily Dashboard  — one row per day, one column per channel, with a stacked chart above it.
 *   CV Lifecycle     — one row per CV, every stage stamped in Cairo local time.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * STABILITY IS THE GOVERNING CONSTRAINT. READ THIS BEFORE CHANGING ANYTHING.
 *
 * The Marketing Requests sheet learned this the hard way: its first version moved, resized and
 * flickered while it was being read, because it re-applied layout on every one-minute pull. A
 * report you cannot rest your eyes on is not a report. The rule is absolute and this file inherits
 * it unchanged:
 *
 *     A REFRESH WRITES VALUES. IT TOUCHES NOTHING ELSE.
 *
 * Column widths, freezing, banding, number formats, the filter and the chart are built ONCE — on
 * first run, or if the feed's column set ever changes — and are never re-applied afterwards.
 * Anything that resizes a column or rebuilds the chart on a routine refresh is a bug, however
 * cosmetic it looks in isolation.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS SHEET DOES NOT KNOW, SAID PLAINLY.
 *
 * "Reached Phoenix" is when the CV arrived at Phoenix, NOT when the candidate pressed send.
 * WhatsApp does not pass the sender's own send time through to us, so nothing in this system holds
 * it. The gap is normally seconds. The column is named for what it is, the Summary tab repeats it
 * in words, and the "Accuracy of that time" column says, per row, whether the stamp came from the
 * webhook itself (exact), from the intake step a poll cycle later, or — for a CV somebody uploaded
 * by hand — from the moment it was saved.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * SETUP, ONCE
 *
 *   1. Extensions ▸ Apps Script, paste this file, save.
 *   2. Project Settings ▸ Script Properties ▸ add:
 *          FEED_URL = https://phoenix-hr.satopharma.com/api/share/cv-lifecycle/<token>/feed
 *      The token is minted inside Phoenix. Put it HERE, never in a cell — a cell is visible to
 *      everyone the sheet is shared with, and this token is a bearer credential.
 *   3. Run `installTrigger` once and grant the permissions it asks for.
 *   4. Run `refreshCvLifecycle` once to fill the sheet immediately.
 *
 * KEEP THE SHEET PRIVATE. The token cannot be typed by a script that has to log in, so the sheet's
 * own Google sharing is the real access control. Anyone you share this sheet with can read every
 * candidate's name and phone number.
 */

/** How often the sheet pulls. Five minutes: CVs arrive in ones and twos, not in floods. */
var REFRESH_MINUTES = 5;

var TAB_SUMMARY = 'Summary';
var TAB_DAILY = 'Daily Dashboard';
var TAB_LIFECYCLE = 'CV Lifecycle';

/** Where each tab's table starts. The daily chart lives above its table, in the reserved band. */
var DAILY_HEADER_ROW = 14;
var LIFECYCLE_HEADER_ROW = 1;
var SUMMARY_HEADER_ROW = 1;

var COLOUR_HEADER_BG = '#1f3864';
var COLOUR_HEADER_FG = '#ffffff';
var COLOUR_GOOD = '#0f7b3f';
var COLOUR_BAD = '#b3261e';

// ─────────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────────

/** Install the timer. Safe to run twice — the old trigger is removed first. */
function installTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'refreshCvLifecycle') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('refreshCvLifecycle').timeBased().everyMinutes(REFRESH_MINUTES).create();
  SpreadsheetApp.getActive().toast('Refreshing every ' + REFRESH_MINUTES + ' minutes.', 'Phoenix', 5);
}

/** A menu, so the sheet can be refreshed by hand without opening the script editor. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Phoenix')
    .addItem('Refresh now', 'refreshCvLifecycle')
    .addItem('Start automatic refresh', 'installTrigger')
    .addToUi();
}

/**
 * The whole refresh. One fetch fills all three tabs.
 *
 * ONE FETCH, NOT THREE. Apps Script pays a round trip per call and the tabs must agree with each
 * other: three independent pulls could straddle a new CV arriving and show a daily total that does
 * not match the rows below it.
 */
function refreshCvLifecycle() {
  var url = PropertiesService.getScriptProperties().getProperty('FEED_URL');
  if (!url) {
    throw new Error('Set the FEED_URL script property first — see the setup notes at the top of this file.');
  }

  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = response.getResponseCode();
  if (code !== 200) {
    // Surfaced rather than swallowed: a revoked or expired token is the likeliest cause, and a
    // sheet that silently keeps showing last week's numbers is worse than one that says it failed.
    throw new Error('Phoenix answered ' + code + ': ' + response.getContentText().slice(0, 200));
  }

  var sections = parseSections_(response.getContentText());
  var ss = SpreadsheetApp.getActive();

  writeSummary_(ss, sections.SUMMARY || []);
  writeDaily_(ss, sections.DAILY || []);
  writeLifecycle_(ss, sections.LIFECYCLE || []);
}

// ─────────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Split the bundle into its `#SECTION` blocks.
 *
 * `Utilities.parseCsv` handles the RFC4180 quoting for us, which matters: candidate names contain
 * commas, and a hand-rolled split on ',' would tear one name into two columns and shift every cell
 * after it. The leading BOM is stripped first — it is there so Excel opens Arabic names correctly,
 * and left in place it would become part of the first section marker.
 */
function parseSections_(text) {
  var body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  var rows = Utilities.parseCsv(body);
  var sections = {};
  var current = null;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var first = row && row.length ? String(row[0]) : '';
    if (first.charAt(0) === '#') {
      current = first.slice(1);
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(row);
  }
  return sections;
}

// ─────────────────────────────────────────────────────────────────────────────────
// Writing — values every time, layout only when it is missing
// ─────────────────────────────────────────────────────────────────────────────────

function sheetFor_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

/**
 * Has this tab already been laid out for exactly these columns?
 *
 * The header row itself is the record. Comparing it to the feed's header means layout is rebuilt
 * when — and only when — the feed's column set actually changes, which is the one case where the
 * old widths and formats are genuinely wrong.
 */
function layoutIsCurrent_(sheet, headerRow, header) {
  if (sheet.getLastRow() < headerRow) return false;
  var existing = sheet.getRange(headerRow, 1, 1, header.length).getValues()[0];
  for (var i = 0; i < header.length; i++) {
    if (String(existing[i]) !== String(header[i])) return false;
  }
  return true;
}

/** Clear only the DATA, never the header or the chart band above it. */
function clearDataBelow_(sheet, headerRow, width) {
  var lastRow = sheet.getLastRow();
  if (lastRow > headerRow) {
    sheet.getRange(headerRow + 1, 1, lastRow - headerRow, Math.max(width, sheet.getLastColumn())).clearContent();
  }
}

function styleHeader_(sheet, headerRow, width) {
  var range = sheet.getRange(headerRow, 1, 1, width);
  range.setBackground(COLOUR_HEADER_BG).setFontColor(COLOUR_HEADER_FG).setFontWeight('bold');
  range.setVerticalAlignment('middle').setWrap(true);
  sheet.setRowHeight(headerRow, 34);
  sheet.setFrozenRows(headerRow);
}

function writeSummary_(ss, rows) {
  if (!rows.length) return;
  var sheet = sheetFor_(ss, TAB_SUMMARY);
  var header = rows[0];
  var body = rows.slice(1);

  var fresh = !layoutIsCurrent_(sheet, SUMMARY_HEADER_ROW, header);
  clearDataBelow_(sheet, SUMMARY_HEADER_ROW, header.length);

  sheet.getRange(SUMMARY_HEADER_ROW, 1, 1, header.length).setValues([header]);
  if (body.length) {
    sheet.getRange(SUMMARY_HEADER_ROW + 1, 1, body.length, header.length).setValues(body);
  }

  if (fresh) {
    styleHeader_(sheet, SUMMARY_HEADER_ROW, header.length);
    sheet.setColumnWidth(1, 260);
    // Wide, because the last row of this tab is the paragraph explaining what "Reached Phoenix"
    // does and does not mean. That sentence is the point of the tab, not a footnote.
    sheet.setColumnWidth(2, 620);
    sheet.getRange(SUMMARY_HEADER_ROW + 1, 2, 200, 1).setWrap(true).setVerticalAlignment('top');
  }
}

function writeDaily_(ss, rows) {
  if (!rows.length) return;
  var sheet = sheetFor_(ss, TAB_DAILY);
  var header = rows[0];
  var body = rows.slice(1);

  var fresh = !layoutIsCurrent_(sheet, DAILY_HEADER_ROW, header);
  clearDataBelow_(sheet, DAILY_HEADER_ROW, header.length);

  sheet.getRange(DAILY_HEADER_ROW, 1, 1, header.length).setValues([header]);
  if (body.length) {
    sheet.getRange(DAILY_HEADER_ROW + 1, 1, body.length, header.length).setValues(body);
  }

  if (fresh) {
    styleHeader_(sheet, DAILY_HEADER_ROW, header.length);
    sheet.setColumnWidth(1, 110);
    for (var c = 2; c <= header.length; c++) sheet.setColumnWidth(c, 150);
    // Whole numbers. Without this a count of 7 can render as 7.00 once the column has ever held a
    // formatted value, which looks like a bug in the data.
    sheet.getRange(DAILY_HEADER_ROW + 1, 2, 1000, header.length - 1).setNumberFormat('0');
    buildDailyChart_(sheet, header.length);
  }
}

/**
 * The stacked column chart, built ONCE and never rebuilt.
 *
 * THE RANGE IS FIXED AT 1000 ROWS RATHER THAN SIZED TO THE DATA. A chart re-pointed at a growing
 * range would have to be rebuilt on every refresh — the exact churn this file exists to avoid — and
 * a rebuilt chart loses whatever position the reader dragged it to. Blank rows inside the range
 * simply do not plot, so an over-long range costs nothing but is stable for about three years of
 * daily rows.
 */
function buildDailyChart_(sheet, width) {
  var existing = sheet.getCharts();
  for (var i = 0; i < existing.length; i++) sheet.removeChart(existing[i]);

  var lastDataRow = DAILY_HEADER_ROW + 1000;
  var chart = sheet
    .newChart()
    .setChartType(Charts.ChartType.COLUMN)
    // Day, then the three channel columns — not the totals, which would double the height of every
    // bar and hide the split the chart exists to show.
    .addRange(sheet.getRange(DAILY_HEADER_ROW, 1, lastDataRow - DAILY_HEADER_ROW + 1, 4))
    .setPosition(1, 1, 0, 0)
    .setOption('title', 'CVs received each day, by channel')
    .setOption('isStacked', true)
    .setOption('legend', { position: 'top' })
    .setOption('height', 260)
    .setOption('width', 1100)
    .setOption('colors', ['#25d366', '#4285f4', '#9aa0a6'])
    .setOption('hAxis', { title: 'Day (Cairo)', slantedText: true, slantedTextAngle: 45 })
    .setOption('vAxis', { title: 'CVs', minValue: 0 })
    .build();
  sheet.insertChart(chart);
}

function writeLifecycle_(ss, rows) {
  if (!rows.length) return;
  var sheet = sheetFor_(ss, TAB_LIFECYCLE);
  var header = rows[0];
  var body = rows.slice(1);

  var fresh = !layoutIsCurrent_(sheet, LIFECYCLE_HEADER_ROW, header);
  clearDataBelow_(sheet, LIFECYCLE_HEADER_ROW, header.length);

  sheet.getRange(LIFECYCLE_HEADER_ROW, 1, 1, header.length).setValues([header]);
  if (body.length) {
    sheet.getRange(LIFECYCLE_HEADER_ROW + 1, 1, body.length, header.length).setValues(body);
  }

  if (fresh) {
    styleHeader_(sheet, LIFECYCLE_HEADER_ROW, header.length);
    sheet.setFrozenColumns(2);
    applyLifecycleWidths_(sheet, header);
    applyOnDriveColours_(sheet, header);
    if (!sheet.getFilter()) {
      sheet.getRange(LIFECYCLE_HEADER_ROW, 1, sheet.getMaxRows() - LIFECYCLE_HEADER_ROW + 1, header.length)
        .createFilter();
    }
  }
}

/** Widths by column NAME, so inserting a column upstream cannot silently mis-size the sheet. */
function applyLifecycleWidths_(sheet, header) {
  var widths = {
    '#': 50,
    'Candidate': 220,
    'Phone': 140,
    'Channel': 130,
    'Sender / mailbox': 180,
    'Applied for': 180,
    'File': 240,
    'Size (KB)': 90,
    'Reached Phoenix': 150,
    'Accuracy of that time': 220,
    'Saved in Phoenix': 150,
    'In Phoenix?': 100,
    'Saved in Google Drive': 160,
    'On Google Drive?': 130,
    'Drive folder': 320,
    'Phoenix → Drive (minutes)': 170,
    'Drive problem': 240,
    'Intake status': 120,
    'Intake error': 240,
    'Applicant answered at': 160,
    'Filed folder': 220,
    'Region': 100,
    'Area': 160,
    'Candidate status': 150,
    'Open in Drive': 220,
    'Open in Phoenix': 220
  };
  for (var i = 0; i < header.length; i++) {
    var width = widths[String(header[i])];
    if (width) sheet.setColumnWidth(i + 1, width);
  }
}

/**
 * Green for a CV that reached Drive, red for one that did not.
 *
 * A conditional format rather than a written colour: it costs one rule instead of a per-row write
 * on every refresh, and it keeps working as rows are added and removed underneath it.
 */
function applyOnDriveColours_(sheet, header) {
  var index = -1;
  for (var i = 0; i < header.length; i++) {
    if (String(header[i]) === 'On Google Drive?') index = i + 1;
  }
  if (index < 0) return;

  var range = sheet.getRange(LIFECYCLE_HEADER_ROW + 1, index, sheet.getMaxRows() - LIFECYCLE_HEADER_ROW, 1);
  var yes = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('Yes')
    .setFontColor(COLOUR_GOOD)
    .setBold(true)
    .setRanges([range])
    .build();
  var no = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('No')
    .setFontColor(COLOUR_BAD)
    .setBold(true)
    .setRanges([range])
    .build();
  sheet.setConditionalFormatRules(sheet.getConditionalFormatRules().concat([yes, no]));
}
