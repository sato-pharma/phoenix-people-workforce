/**
 * Phoenix Workforce — CV Lifecycle live Google Sheet
 * ==================================================================================
 * The full life of every CV, from reaching Phoenix to sitting in the owner's Google Drive, in a
 * sheet that fills itself and is meant to be looked at rather than read. Four tabs:
 *
 *   Summary          — the cover page: six headline tiles, the daily shape, where CVs come from,
 *                      the busiest Drive folders, and the one caveat nobody should miss.
 *   Daily Dashboard  — one row per day, one column per channel, beside a stacked chart.
 *   CV Details       — one row per PERSON: everything Phoenix knows about the candidate, from
 *                      governorate and education to the answers they typed into WhatsApp.
 *   CV Lifecycle     — one row per CV, every stage stamped in Cairo local time.
 *
 * The two middle tabs answer different questions and are deliberately not merged. Daily Dashboard
 * counts FILES arriving; CV Details describes PEOPLE. 982 files belong to 744 candidates, so one
 * table cannot be both without either double-counting a person or hiding a CV.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * STABILITY IS THE GOVERNING CONSTRAINT. READ THIS BEFORE CHANGING ANYTHING.
 *
 * The Marketing Requests sheet learned this the hard way: its first version moved, resized and
 * flickered while it was being read, because it re-applied layout on every pull. A report you
 * cannot rest your eyes on is not a report. The rule is absolute and this file inherits it:
 *
 *     A REFRESH WRITES VALUES. IT TOUCHES NOTHING ELSE.
 *
 * Widths, merges, freezing, banding, number formats, the filter, the charts and the conditional
 * colours are built ONCE — on first run, or when LAYOUT_VERSION or the feed's column set changes —
 * and are never re-applied afterwards. Anything that resizes a column or rebuilds a chart on a
 * routine refresh is a bug, however cosmetic it looks in isolation. Tab ORDER is part of layout
 * too: re-ordering calls setActiveSheet, which would yank the reader to another tab mid-read, so
 * it happens only on a rebuild.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * A FAILED REFRESH MUST NEVER BE SILENT. THIS IS THE HALF THAT COST EIGHTEEN DAYS.
 *
 * The last good data stays on screen when a fetch fails — a sheet that blanks itself reads as
 * "every CV is gone", which is worse than stale data. But the first version of this file THREW on
 * failure, which in a time-driven trigger means the numbers simply stop moving while the tab goes
 * on looking perfectly normal. That is exactly how a revoked Direct Orders token left that sheet
 * showing 5 August figures until 24 August, refreshing every minute the whole time.
 *
 * So every failure path here returns quietly to the DATA and loudly to the READER: row 2 of every
 * tab turns into a red STALE banner naming when the figures froze and why the last attempt failed,
 * and the next good refresh puts the ordinary subtitle back. Painted only when the state CHANGES,
 * so a long outage costs nothing per refresh. `markFeedStale` never throws — a banner that broke
 * the trigger would turn a stale sheet into a dead one.
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
 * UPGRADING FROM AN EARLIER VERSION: paste over the whole file and run `refreshCvLifecycle`.
 * LAYOUT_VERSION below has changed, so every tab rebuilds itself once and then settles.
 *
 * SETUP, OPTIONAL — LET PHOENIX ROTATE THE TOKEN FOR YOU
 *
 * Without this the token in FEED_URL is a long-lived secret: whoever ever sees it can read every
 * candidate's name and phone number until somebody notices and revokes it by hand. With it, Phoenix
 * replaces that token every week and the old one is dead within the hour, so a leaked token is
 * self-healing rather than permanent.
 *
 *   5. Deploy ▸ New deployment ▸ Web app. Execute as ME, access ANYONE. Copy the /exec URL.
 *      "Anyone" is required because Phoenix calls it unauthenticated — which is exactly why the
 *      URL alone must not be enough, and why step 6 is not optional.
 *   6. Project Settings ▸ Script Properties ▸ add:
 *          WEBHOOK_SECRET = <a long random string>
 *      There is deliberately NO fallback: with this unset, doPost refuses every caller. A push
 *      endpoint that accepts anyone on the internet because a property is missing is not a
 *      degraded feature, it is an open door.
 *   7. In Phoenix's environment set both:
 *          CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_URL    = the /exec URL from step 5
 *          CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_SECRET = the same string as step 6
 *
 * Rotation does NOT extend the expiry date — deliberately, and matching the other two sheets. Each
 * token lives a week; the LINK still dies on its original date, and Phoenix warns you in-app and on
 * Telegram for the 30 days before that. A link that renewed itself forever would be an unowned copy
 * of the candidate pool, which is the one thing the mandatory expiry exists to prevent.
 *
 * KEEP THE SHEET PRIVATE. The token cannot be typed by a script that has to log in, so the sheet's
 * own Google sharing is the real access control. Anyone you share this sheet with can read every
 * candidate's name and phone number.
 */

/** How often the sheet pulls. Five minutes: CVs arrive in ones and twos, not in floods. */
var REFRESH_MINUTES = 5;

var TZ = 'Africa/Cairo';

/**
 * Bump this to force every tab to rebuild its layout on the next refresh.
 *
 * Without it a pure DESIGN change — new colours, a new tile, a moved chart — would never reach a
 * sheet somebody has already set up, because the old fingerprint only noticed a change in the
 * feed's COLUMNS. A sheet that silently keeps the previous design is indistinguishable from one
 * where the update failed.
 */
var LAYOUT_VERSION = 'v3-detail';

var TAB_SUMMARY = 'Summary';
var TAB_DAILY = 'Daily Dashboard';
var TAB_LIFECYCLE = 'CV Lifecycle';
var TAB_DETAIL = 'CV Details';
var TAB_ORDER = [TAB_SUMMARY, TAB_DAILY, TAB_DETAIL, TAB_LIFECYCLE];

// Rows shared by every tab, so the stale banner knows where to paint on all three.
var ROW_TITLE = 1;
var ROW_SUBTITLE = 2;

// Summary tab geography. Fixed rows, because tiles and charts must not move under the reader.
var SUMMARY_COLS = 6;
var TILE_ROWS = [4, 8, 12];
var SUMMARY_SPARK_TITLE_ROW = 16;
var SUMMARY_SPARK_ROW = 17;
var SUMMARY_CHANNEL_TITLE_ROW = 19;
var SUMMARY_CHANNEL_HEADER_ROW = 20;
var SUMMARY_FOLDER_TITLE_ROW = 31;
var SUMMARY_FOLDER_HEADER_ROW = 32;
var SUMMARY_FOLDER_COUNT = 5;
var SUMMARY_CAVEAT_ROW = 39;
var SUMMARY_METRIC_TITLE_ROW = 43;
var SUMMARY_METRIC_HEADER_ROW = 44;
var SUMMARY_METRIC_CAPACITY = 40;

// EVERY TABLE STARTS AT ROW 4, AND THAT IS A FIX, NOT A PREFERENCE.
//
// The Daily Dashboard used to put its header at row 20 and reserve rows 4-19 as a canvas for the
// chart. A Sheets chart is a floating OVERLAY — it never occupies cells — so what the reader
// actually saw was sixteen empty rows above a header frozen a long way down the page, which is
// precisely what the owner reported on 2026-09-05. The chart now floats to the RIGHT of the data
// instead, where it cannot push anything down and cannot leave a hole if it fails to draw at all.
var DAILY_HEADER_ROW = 4;
var DETAIL_HEADER_ROW = 4;
var LIFECYCLE_HEADER_ROW = 4;

/** How many rows the fixed chart and format ranges cover. About three years of daily rows. */
var FIXED_RANGE_ROWS = 1000;

// ── Palette ──────────────────────────────────────────────────────────────────────
var INK = '#0b1f3a';
var HEADER_BG = '#1f3864';
var HEADER_FG = '#ffffff';
var PAPER = '#ffffff';
var MUTED = '#5f6368';
var RULE = '#d7dee8';
var TILE_BG = '#f6f8fc';
var GOOD = '#0f7b3f';
var GOOD_BG = '#e7f8ee';
var BAD = '#b3261e';
var BAD_BG = '#fce8e6';
var WARN_BG = '#fff4d6';
var WARN_FG = '#7a5b00';
var C_WHATSAPP = '#25d366';
var C_EMAIL = '#4285f4';
var C_HAND = '#9aa0a6';

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

/** A menu, so the sheet can be driven without opening the script editor. */
/**
 * Push endpoint — how Phoenix rotates this sheet's feed token without anybody opening the editor.
 *
 * WHY THIS EXISTS. The token in FEED_URL reads every candidate's name and phone number and has no
 * password. Before this handler it was a long-lived secret: the only way to replace it was for the
 * owner to mint a new link, open Apps Script and paste it, so in practice it never changed. Now
 * Phoenix mints a replacement weekly and hands it over here, and the old one is revoked within the
 * hour — a leaked token stops being permanent and becomes a week-long problem that heals itself.
 *
 * WHY A WEB APP AND NOT THE SHEETS API. The `iam.disableServiceAccountKeyCreation` org policy
 * blocks creating a service-account key, correctly — long-lived JSON keys leak. This script already
 * runs as the sheet's owner, so a Web App deployment needs no key, no GCP project and no exemption.
 *
 * SECURITY, AND THE ONE DIFFERENCE FROM THE DIRECT-ORDERS SCRIPT.
 * The deployment has to be reachable by "Anyone", so the URL cannot be the credential. WEBHOOK_SECRET
 * is what authorises, and there is deliberately NO fallback to the feed token here. The direct-orders
 * script falls back, and its own comment explains why that is safe THERE: anyone holding its feed
 * token can already read its feed, so authorising a refresh with it grants nothing new. That
 * reasoning does not survive the move to this sheet. Falling back would make the feed token — which
 * reads candidate PII — double as the key that can REPLACE the feed token, so a single leaked token
 * would let its holder keep the sheet pointed wherever they liked. Unset means refuse, always.
 */
function doPost(e) {
  var expected = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  if (!expected) {
    // Fail CLOSED. The opposite — accepting everything until someone remembers to set a property —
    // is how a fresh deployment quietly becomes an open endpoint.
    return textOut_('not configured');
  }

  var payload = {};
  try {
    payload = JSON.parse(e && e.postData ? e.postData.contents : '{}') || {};
  } catch (err) {
    payload = {};
  }
  // Deliberately vague: a caller learns whether it is authorised, never why not.
  if (String(payload.secret || '') !== expected) return textOut_('denied');

  var rotate = String(payload.rotateToken || '').trim();
  if (rotate) {
    // Anything that is not a plausible token is refused rather than stored. Writing rubbish into
    // FEED_URL would break every refresh from here on, and the sheet would then report it as a
    // Phoenix failure — a confusing lie about whose fault it is.
    if (!/^[A-Za-z0-9_-]{20,}$/.test(rotate)) return textOut_('bad token');
    if (!storeRotatedToken_(rotate)) return textOut_('bad url');
    // Use it IMMEDIATELY. This is not a courtesy refresh: Phoenix confirms the rotation by watching
    // its own access_count for the new token, and revokes the old one only once that read arrives.
    // A rotation that stored the token but never spent it would look like a failure and be rolled
    // back — leaving the sheet on a token Phoenix believes it abandoned.
    refreshCvLifecycle();
    return textOut_('rotated');
  }

  refreshCvLifecycle();
  return textOut_('ok');
}

/**
 * Swap the token inside the stored FEED_URL, keeping everything else exactly as it was.
 *
 * THE ORIGIN NEVER COMES FROM THE PAYLOAD, and that is the point of rewriting rather than accepting
 * a whole URL. If this took `feedUrl` from the caller, one leaked WEBHOOK_SECRET would let someone
 * repoint the sheet at a server they control — and the sheet would go on filling, with plausible
 * rows, showing data nobody at Phoenix wrote. Rewriting one path segment means the worst an
 * authorised caller can do is change which Phoenix token is used.
 *
 * Idempotent on purpose: a retried push carrying the token already stored is a success, not a
 * failure. Phoenix retries, and the second attempt must not report `bad url`.
 */
function storeRotatedToken_(newToken) {
  var props = PropertiesService.getScriptProperties();
  var current = props.getProperty('FEED_URL');
  if (!current) return false;

  var pattern = /(\/api\/share\/cv-lifecycle\/)[^\/?#]+(\/feed)/;
  if (!pattern.test(current)) return false;

  props.setProperty('FEED_URL', current.replace(pattern, '$1' + newToken + '$2'));
  return true;
}

/** Apps Script's plain-text reply, in one place so every branch above answers the same shape. */
function textOut_(message) {
  return ContentService.createTextOutput(message).setMimeType(ContentService.MimeType.TEXT);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Phoenix')
    .addItem('Refresh now', 'refreshCvLifecycle')
    .addItem('Start automatic refresh', 'installTrigger')
    .addSeparator()
    .addItem('Rebuild the layout', 'rebuildLayout')
    .addToUi();
}

/**
 * Forget every layout fingerprint, then refresh — so the next pass redraws all three tabs.
 *
 * The escape hatch for a sheet whose formatting has been edited by hand into a state the script
 * would otherwise leave alone, since the script only ever rewrites VALUES.
 */
function rebuildLayout() {
  var props = PropertiesService.getDocumentProperties();
  for (var i = 0; i < TAB_ORDER.length; i++) props.deleteProperty('layout:' + TAB_ORDER[i]);
  refreshCvLifecycle();
}

/**
 * The whole refresh. One fetch fills all three tabs.
 *
 * ONE FETCH, NOT THREE. Apps Script pays a round trip per call and the tabs must agree with each
 * other: three independent pulls could straddle a new CV arriving and show a daily total that does
 * not match the rows below it.
 *
 * NOTHING HERE THROWS. Every exit is a `markFeedStale` and a return, so the previous figures stay
 * on screen with a red banner over them saying they are old. See the note at the top of the file.
 */
function refreshCvLifecycle() {
  var url = PropertiesService.getScriptProperties().getProperty('FEED_URL');
  if (!url) {
    markFeedStale('FEED_URL is not set in Project Settings then Script Properties');
    return;
  }

  var response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    markFeedStale('Phoenix could not be reached (' + err + ')');
    return;
  }

  var code = response.getResponseCode();
  if (code !== 200) {
    // Built above the call, not inside it: the stale-banner suite proves each bail-out announces
    // itself by looking a few lines back from the `return`, and a multi-line argument list pushes
    // the announcement out of that window even though the code is correct.
    var why = 'Phoenix answered ' + code;
    if (code === 403) why += ' — the link has been revoked or has expired';
    if (code === 404) why += ' — the link no longer exists';
    markFeedStale(why);
    return;
  }

  var sections;
  try {
    sections = parseSections_(response.getContentText());
  } catch (err) {
    markFeedStale('The feed arrived but could not be read (' + err + ')');
    return;
  }

  var lifecycle = sections.LIFECYCLE || [];
  if (lifecycle.length < 2) {
    // Header only, or nothing at all. Writing that over a full sheet would erase every CV.
    markFeedStale('Phoenix answered, but sent no CV rows');
    return;
  }

  var ss = SpreadsheetApp.getActive();
  var stamp = Utilities.formatDate(new Date(), TZ, 'dd MMM yyyy, HH:mm');

  var rebuilt = false;
  rebuilt = writeSummary_(ss, sections.SUMMARY || [], sections.DAILY || [], lifecycle, stamp) || rebuilt;
  rebuilt = writeDaily_(ss, sections.DAILY || [], stamp) || rebuilt;
  rebuilt = writeDetail_(ss, sections.DETAIL || [], stamp) || rebuilt;
  rebuilt = writeLifecycle_(ss, lifecycle, stamp) || rebuilt;

  // Only on a rebuild: ordering tabs calls setActiveSheet, which would drag the reader off
  // whatever tab they were on, every five minutes, for ever.
  if (rebuilt) orderTabs_(ss);

  markFeedFresh(ss, stamp);
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
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────────

function sheetFor_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

/** Index of a column by NAME, 1-based, or -1. Never trust position — the feed may gain a column. */
function columnByName_(header, name) {
  for (var i = 0; i < header.length; i++) {
    if (String(header[i]) === name) return i + 1;
  }
  return -1;
}

/** 1 → A, 27 → AA. Used to build the SPARKLINE range as a formula string. */
function columnLetter_(index) {
  var letter = '';
  var n = index;
  while (n > 0) {
    var rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

function toNumber_(value) {
  var text = String(value == null ? '' : value).replace(/,/g, '').trim();
  if (text === '') return null;
  var n = Number(text);
  return isNaN(n) ? null : n;
}

function median_(numbers) {
  if (!numbers.length) return null;
  var sorted = numbers.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Has this tab already been laid out for exactly this design AND these columns?
 *
 * Kept in Document Properties rather than read back off the sheet: the old version compared the
 * header row, which cannot see a change that leaves the columns alone — every purely visual
 * change, in other words.
 */
function layoutIsCurrent_(key, header) {
  var want = LAYOUT_VERSION + '|' + header.join('|');
  return PropertiesService.getDocumentProperties().getProperty('layout:' + key) === want;
}

function markLayoutBuilt_(key, header) {
  PropertiesService.getDocumentProperties()
    .setProperty('layout:' + key, LAYOUT_VERSION + '|' + header.join('|'));
}

/**
 * Strip a tab back to bare cells before rebuilding it.
 *
 * Without this an upgrade LAYERS the new design over the old one: the previous chart stays behind
 * the new chart, old conditional rules keep colouring cells the new design left plain, and old
 * merges block the new ones. Every rebuild therefore starts from nothing.
 */
function resetTab_(sheet) {
  var charts = sheet.getCharts();
  for (var i = 0; i < charts.length; i++) sheet.removeChart(charts[i]);

  sheet.clearConditionalFormatRules();

  var bandings = sheet.getBandings();
  for (var b = 0; b < bandings.length; b++) bandings[b].remove();

  var filter = sheet.getFilter();
  if (filter) filter.remove();

  sheet.setFrozenRows(0);
  sheet.setFrozenColumns(0);
  sheet.showColumns(1, sheet.getMaxColumns());
  sheet.showRows(1, sheet.getMaxRows());

  var all = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
  all.breakApart();
  all.clear();
}

/** The dark title band and the subtitle line the stale banner later paints over. */
function titleBand_(sheet, cols, title) {
  sheet.setHiddenGridlines(true);
  sheet.setTabColor(HEADER_BG);

  sheet.getRange(ROW_TITLE, 1, 1, cols).merge()
    .setValue(title)
    .setBackground(INK)
    .setFontColor(HEADER_FG)
    .setFontSize(20)
    .setFontWeight('bold')
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('left');
  sheet.setRowHeight(ROW_TITLE, 48);

  sheet.getRange(ROW_SUBTITLE, 1, 1, cols).merge()
    .setBackground(PAPER)
    .setFontColor(MUTED)
    .setFontStyle('italic')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(ROW_SUBTITLE, 24);
  sheet.setRowHeight(3, 10);
}

/** The ordinary subtitle. Contains the word the stale detector looks for — do not reword it. */
function writeSubtitle_(sheet, name, stamp) {
  sheet.getRange(ROW_SUBTITLE, 1).setValue(name + ' — refreshed ' + stamp + ' (Cairo)');
}

function sectionTitle_(sheet, row, cols, text) {
  sheet.getRange(row, 1, 1, cols).merge()
    .setValue(text)
    .setFontSize(12)
    .setFontWeight('bold')
    .setFontColor(INK)
    .setVerticalAlignment('middle');
  sheet.setRowHeight(row, 28);
}

function styleHeader_(sheet, headerRow, width) {
  var range = sheet.getRange(headerRow, 1, 1, width);
  range.setBackground(HEADER_BG).setFontColor(HEADER_FG).setFontWeight('bold');
  range.setVerticalAlignment('middle').setWrap(true);
  sheet.setRowHeight(headerRow, 34);
}

/** A KPI tile: three rows tall, three columns wide, label over a large number. */
function buildTile_(sheet, row, col, label) {
  sheet.getRange(row, col, 3, 3)
    .setBackground(TILE_BG)
    .setBorder(true, true, true, true, false, false, RULE, SpreadsheetApp.BorderStyle.SOLID);

  sheet.getRange(row, col, 1, 3).merge()
    .setValue(label)
    .setFontSize(10)
    .setFontColor(MUTED)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  sheet.getRange(row + 1, col, 2, 3).merge()
    .setFontSize(26)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  sheet.setRowHeight(row, 20);
  sheet.setRowHeight(row + 1, 26);
  sheet.setRowHeight(row + 2, 26);
}

/** Values only — the tile's box, fonts and merges were built once. */
function fillTile_(sheet, row, col, value, colour) {
  sheet.getRange(row + 1, col).setValue(value).setFontColor(colour || INK);
}

// ─────────────────────────────────────────────────────────────────────────────────
// Staleness banner
// ─────────────────────────────────────────────────────────────────────────────────
//
// Only cells already holding a live "refreshed …" stamp are ever repainted, so a tab carrying
// something else cannot be overwritten by the warning.

var FEED_STATE_KEY = 'phoenixCvFeedState';
var LAST_GOOD_KEY = 'phoenixCvLastGoodStamp';
var STALE_MARKER = '⚠ STALE';
var STALE_BG = '#b91c1c';
var STALE_FG = '#ffffff';

/** The subtitle cells that carry a live refresh stamp, and are therefore safe to repaint. */
function stampedSubtitles(ss) {
  var out = [];
  for (var i = 0; i < TAB_ORDER.length; i++) {
    var sheet = ss.getSheetByName(TAB_ORDER[i]);
    if (!sheet) continue;
    var cell = sheet.getRange(ROW_SUBTITLE, 1);
    var text = String(cell.getValue() || '');
    if (text.indexOf('refreshed ') === -1 && text.indexOf(STALE_MARKER) !== 0) continue;
    out.push({ before: text, cell: cell, cols: Math.max(1, sheet.getLastColumn()), sheet: sheet });
  }
  return out;
}

/**
 * Say, on the face of the sheet, that what it shows is no longer live.
 *
 * Never throws: this runs on the failure path, and a banner that breaks the trigger would turn a
 * stale sheet into a dead one.
 */
function markFeedStale(reason) {
  try {
    var props = PropertiesService.getScriptProperties();
    // Keyed on the reason too, so a 403 that becomes a network outage repaints with the new cause
    // instead of leaving the first explanation up for ever.
    var state = 'stale:' + reason;
    if (props.getProperty(FEED_STATE_KEY) === state) return;

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return;

    var frozenAt = props.getProperty(LAST_GOOD_KEY);
    var now = Utilities.formatDate(new Date(), TZ, 'dd MMM yyyy, HH:mm');
    var message = STALE_MARKER + ' — these figures stopped updating '
      + (frozenAt ? 'on ' + frozenAt : 'at some point before this script was updated')
      + ' (Cairo). Last attempt ' + now + ' failed: ' + reason
      + '. Still retrying every ' + REFRESH_MINUTES
      + ' minutes; this line clears itself the moment the feed answers.';

    var targets = stampedSubtitles(ss);
    for (var i = 0; i < targets.length; i++) {
      targets[i].sheet.getRange(ROW_SUBTITLE, 1, 1, targets[i].cols).setBackground(STALE_BG);
      targets[i].cell
        .setValue(message)
        .setFontColor(STALE_FG)
        .setFontStyle('normal')
        .setFontWeight('bold');
    }
    props.setProperty(FEED_STATE_KEY, state);
  } catch (err) {
    console.error('Could not paint the stale banner (the refresh failure above is the real problem): ' + err);
  }
}

/**
 * Record a good refresh, and take the banner down if one is up.
 *
 * Called AFTER the tabs are drawn, so their own fresh subtitles win. A tab this pass did not
 * rewrite still carries the banner text, and is given a plain stamp rather than a guess at what
 * its subtitle used to say.
 */
function markFeedFresh(ss, stamp) {
  try {
    var props = PropertiesService.getScriptProperties();
    var previous = String(props.getProperty(FEED_STATE_KEY) || '');
    props.setProperty(LAST_GOOD_KEY, stamp);
    if (previous.indexOf('stale:') !== 0) return;

    var targets = stampedSubtitles(ss);
    for (var i = 0; i < targets.length; i++) {
      var cell = targets[i].cell;
      if (targets[i].before.indexOf(STALE_MARKER) === 0) {
        cell.setValue(targets[i].sheet.getName() + ' — refreshed ' + stamp + ' (Cairo)');
      }
      targets[i].sheet.getRange(ROW_SUBTITLE, 1, 1, targets[i].cols).setBackground(PAPER);
      cell.setFontColor(MUTED).setFontStyle('italic').setFontWeight('normal');
    }
    props.setProperty(FEED_STATE_KEY, 'ok');
  } catch (err) {
    console.error('Could not clear the stale banner: ' + err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
// Summary — the cover page
// ─────────────────────────────────────────────────────────────────────────────────

/** The feed's Metric/Value pairs as a lookup, so a tile asks for a metric by name. */
function metricMap_(rows) {
  var map = {};
  for (var i = 1; i < rows.length; i++) {
    if (rows[i] && rows[i].length >= 2) map[String(rows[i][0])] = String(rows[i][1]);
  }
  return map;
}

/** Sum one named column of the DAILY section. */
function dailyTotal_(dailyRows, name) {
  if (!dailyRows.length) return 0;
  var col = columnByName_(dailyRows[0], name);
  if (col < 0) return 0;
  var total = 0;
  for (var i = 1; i < dailyRows.length; i++) {
    var n = toNumber_(dailyRows[i][col - 1]);
    if (n !== null) total += n;
  }
  return total;
}

/** The busiest Drive folders, as [folder, count] pairs. */
function topFolders_(lifecycleRows, howMany) {
  var col = columnByName_(lifecycleRows[0], 'Drive folder');
  if (col < 0) return [];
  var counts = {};
  for (var i = 1; i < lifecycleRows.length; i++) {
    var name = String(lifecycleRows[i][col - 1] || '').trim();
    if (!name) continue;
    counts[name] = (counts[name] || 0) + 1;
  }
  var pairs = [];
  for (var key in counts) {
    if (Object.prototype.hasOwnProperty.call(counts, key)) pairs.push([key, counts[key]]);
  }
  pairs.sort(function (a, b) { return b[1] - a[1]; });
  return pairs.slice(0, howMany);
}

/**
 * How long Phoenix → Drive normally takes, in minutes.
 *
 * The median, not the average: one stuck file would drag an average somewhere no real CV has ever
 * been, and this number is meant to answer "is the mirror keeping up?" at a glance.
 */
function medianMinutesToDrive_(lifecycleRows) {
  var col = columnByName_(lifecycleRows[0], 'Phoenix → Drive (minutes)');
  if (col < 0) return null;
  var values = [];
  for (var i = 1; i < lifecycleRows.length; i++) {
    var n = toNumber_(lifecycleRows[i][col - 1]);
    if (n !== null) values.push(n);
  }
  return median_(values);
}

function writeSummary_(ss, summaryRows, dailyRows, lifecycleRows, stamp) {
  var sheet = sheetFor_(ss, TAB_SUMMARY);
  var metrics = metricMap_(summaryRows);

  // The layout fingerprint for this tab is the metric NAMES the tiles read, not a data header.
  var fingerprint = ['summary'];
  for (var key in metrics) {
    if (Object.prototype.hasOwnProperty.call(metrics, key)) fingerprint.push(key);
  }
  fingerprint.sort();

  var fresh = !layoutIsCurrent_(TAB_SUMMARY, fingerprint);
  if (fresh) buildSummaryLayout_(sheet, dailyRows);

  writeSubtitle_(sheet, TAB_SUMMARY, stamp);

  // ── Tiles ──
  var total = toNumber_(metrics['CVs in total']);
  var onDrive = toNumber_(metrics['Saved in Google Drive']);
  var missing = toNumber_(metrics['Still missing from Drive']);
  var errors = toNumber_(metrics['Drive errors']);
  var share = (total && onDrive !== null) ? Math.round((onDrive / total) * 100) : null;
  var minutes = medianMinutesToDrive_(lifecycleRows);

  fillTile_(sheet, TILE_ROWS[0], 1, metrics['CVs in total'] || '—', INK);
  fillTile_(sheet, TILE_ROWS[0], 4, metrics['CVs received today'] || '—', INK);
  fillTile_(sheet, TILE_ROWS[1], 1,
    (metrics['Saved in Google Drive'] || '—') + (share === null ? '' : '  (' + share + '%)'),
    share === 100 ? GOOD : INK);
  fillTile_(sheet, TILE_ROWS[1], 4, metrics['Still missing from Drive'] || '—', missing ? BAD : GOOD);
  fillTile_(sheet, TILE_ROWS[2], 1, metrics['Drive errors'] || '—', errors ? BAD : GOOD);
  fillTile_(sheet, TILE_ROWS[2], 4,
    minutes === null ? '—' : (minutes < 1 ? 'under a minute' : Math.round(minutes) + ' min'),
    INK);

  // ── Where they came from ──
  var whatsapp = dailyTotal_(dailyRows, 'WhatsApp');
  var email = dailyTotal_(dailyRows, 'Email');
  var byHand = dailyTotal_(dailyRows, 'Uploaded by hand');
  var channelTotal = whatsapp + email + byHand;
  function pct(n) { return channelTotal ? Math.round((n / channelTotal) * 100) + '%' : '—'; }

  sheet.getRange(SUMMARY_CHANNEL_HEADER_ROW + 1, 1, 3, 3).setValues([
    ['WhatsApp', whatsapp, pct(whatsapp)],
    ['Email', email, pct(email)],
    ['Uploaded by hand', byHand, pct(byHand)]
  ]);

  // ── Busiest Drive folders ──
  var folders = topFolders_(lifecycleRows, SUMMARY_FOLDER_COUNT);
  var folderBlock = [];
  for (var f = 0; f < SUMMARY_FOLDER_COUNT; f++) {
    folderBlock.push(folders[f] ? [folders[f][0], '', folders[f][1]] : ['', '', '']);
  }
  sheet.getRange(SUMMARY_FOLDER_HEADER_ROW + 1, 1, SUMMARY_FOLDER_COUNT, 3).setValues(folderBlock);

  // ── The caveat, in the feed's own words ──
  sheet.getRange(SUMMARY_CAVEAT_ROW, 1).setValue(
    metrics['About "Reached Phoenix"']
    || 'The times here are when the CV reached Phoenix, not when the candidate pressed send.'
  );

  // ── Everything the feed reported, so nothing is lost if a metric is not on a tile ──
  sheet.getRange(SUMMARY_METRIC_HEADER_ROW + 1, 1, SUMMARY_METRIC_CAPACITY, 3).clearContent();
  var metricRows = [];
  for (var m = 1; m < summaryRows.length && metricRows.length < SUMMARY_METRIC_CAPACITY; m++) {
    if (summaryRows[m] && summaryRows[m].length >= 2) {
      metricRows.push([String(summaryRows[m][0]), '', String(summaryRows[m][1])]);
    }
  }
  if (metricRows.length) {
    sheet.getRange(SUMMARY_METRIC_HEADER_ROW + 1, 1, metricRows.length, 3).setValues(metricRows);
  }

  if (fresh) markLayoutBuilt_(TAB_SUMMARY, fingerprint);
  return fresh;
}

function buildSummaryLayout_(sheet, dailyRows) {
  resetTab_(sheet);
  titleBand_(sheet, SUMMARY_COLS, '  CV Lifecycle');

  for (var c = 1; c <= SUMMARY_COLS; c++) sheet.setColumnWidth(c, 150);

  // A thin gap under each row of tiles, so they read as cards rather than as a grid.
  for (var t = 0; t < TILE_ROWS.length; t++) sheet.setRowHeight(TILE_ROWS[t] + 3, 12);

  buildTile_(sheet, TILE_ROWS[0], 1, 'CVs IN TOTAL');
  buildTile_(sheet, TILE_ROWS[0], 4, 'RECEIVED TODAY');
  buildTile_(sheet, TILE_ROWS[1], 1, 'SAVED IN GOOGLE DRIVE');
  buildTile_(sheet, TILE_ROWS[1], 4, 'STILL MISSING FROM DRIVE');
  buildTile_(sheet, TILE_ROWS[2], 1, 'DRIVE ERRORS');
  buildTile_(sheet, TILE_ROWS[2], 4, 'TYPICAL TIME PHOENIX TO DRIVE');

  // ── The daily shape, as one sparkline ──
  sectionTitle_(sheet, SUMMARY_SPARK_TITLE_ROW, SUMMARY_COLS, 'How many arrive each day');
  var totalCol = dailyRows.length ? columnByName_(dailyRows[0], 'Total received') : -1;
  sheet.getRange(SUMMARY_SPARK_ROW, 1, 1, SUMMARY_COLS).merge();
  if (totalCol > 0) {
    // No options object: its array literal uses separators that differ by spreadsheet locale, and
    // a locale mismatch would put a formula error in the middle of the cover page.
    var letter = columnLetter_(totalCol);
    sheet.getRange(SUMMARY_SPARK_ROW, 1).setFormula(
      "=SPARKLINE('" + TAB_DAILY + "'!" + letter + (DAILY_HEADER_ROW + 1)
      + ':' + letter + (DAILY_HEADER_ROW + FIXED_RANGE_ROWS) + ')'
    );
  }
  sheet.setRowHeight(SUMMARY_SPARK_ROW, 52);
  sheet.setRowHeight(SUMMARY_SPARK_ROW + 1, 12);

  // ── Where they came from, plus the donut that reads it ──
  sectionTitle_(sheet, SUMMARY_CHANNEL_TITLE_ROW, SUMMARY_COLS, 'Where they came from');
  sheet.getRange(SUMMARY_CHANNEL_HEADER_ROW, 1, 1, 3).setValues([['Channel', 'CVs', 'Share']]);
  styleHeader_(sheet, SUMMARY_CHANNEL_HEADER_ROW, 3);
  sheet.getRange(SUMMARY_CHANNEL_HEADER_ROW + 1, 2, 3, 1).setNumberFormat('#,##0');
  sheet.getRange(SUMMARY_CHANNEL_HEADER_ROW + 1, 1, 3, 3)
    .setBorder(true, true, true, true, true, true, RULE, SpreadsheetApp.BorderStyle.SOLID);

  var donut = sheet.newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(sheet.getRange(SUMMARY_CHANNEL_HEADER_ROW, 1, 4, 2))
    .setPosition(SUMMARY_CHANNEL_TITLE_ROW, 4, 0, 0)
    .setOption('title', 'Share of all CVs')
    .setOption('pieHole', 0.45)
    .setOption('legend', { position: 'labeled' })
    .setOption('colors', [C_WHATSAPP, C_EMAIL, C_HAND])
    .setOption('height', 230)
    .setOption('width', 440)
    .build();
  sheet.insertChart(donut);

  // ── Busiest folders ──
  sectionTitle_(sheet, SUMMARY_FOLDER_TITLE_ROW, SUMMARY_COLS, 'Busiest Drive folders');
  // Column B is left empty on purpose: an unwrapped folder name overflows into it, which reads
  // better than a wrapped one and costs no per-row merge on every refresh.
  sheet.getRange(SUMMARY_FOLDER_HEADER_ROW, 1, 1, 3).setValues([['Folder', '', 'CVs']]);
  styleHeader_(sheet, SUMMARY_FOLDER_HEADER_ROW, 3);
  sheet.getRange(SUMMARY_FOLDER_HEADER_ROW + 1, 3, SUMMARY_FOLDER_COUNT, 1).setNumberFormat('#,##0');

  // ── The caveat callout ──
  sheet.getRange(SUMMARY_CAVEAT_ROW, 1, 3, SUMMARY_COLS).merge()
    .setBackground(WARN_BG)
    .setFontColor(WARN_FG)
    .setWrap(true)
    .setVerticalAlignment('middle')
    .setBorder(true, true, true, true, false, false, WARN_FG, SpreadsheetApp.BorderStyle.SOLID);

  // ── The raw metric table ──
  sectionTitle_(sheet, SUMMARY_METRIC_TITLE_ROW, SUMMARY_COLS, 'Everything Phoenix reported');
  sheet.getRange(SUMMARY_METRIC_HEADER_ROW, 1, 1, 3).setValues([['Metric', '', 'Value']]);
  styleHeader_(sheet, SUMMARY_METRIC_HEADER_ROW, 3);

  sheet.setFrozenRows(ROW_SUBTITLE);
}

// ─────────────────────────────────────────────────────────────────────────────────
// CV Details — everything Phoenix knows about the PERSON
//
// One row per candidate, not per CV. 982 files belong to 741 people, so a per-file sheet would
// print the same education and work history three times for one applicant and make a duplicate
// look like three candidates.
//
// This tab exists because the pipeline tab could not answer "which area is this person in". The
// old feed carried only the area the candidate DECLARED, which 12% of them ever answered, so the
// column was blank seven times in eight. `governorate` — filled for 76% — was one join away and
// simply never selected. The 2026-09-05 view widening brought it, and the rest of the CV with it.
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * The coloured band over row 3, so 58 columns read as six ideas rather than one wall.
 *
 * Spans are derived from where each `from` column actually sits, never hardcoded. Insert or move a
 * column upstream and the bands follow it; hardcoded spans would drift silently and label the
 * wrong block, which is worse than no band at all.
 */
var DETAIL_GROUPS = [
  { bg: '#e8eef7', from: '#',                    label: 'Who they are' },
  { bg: '#e7f1ea', from: 'Faculty',              label: 'What they studied' },
  { bg: '#fbf0e2', from: 'Applied for',          label: 'What they have done' },
  { bg: '#efe9f7', from: 'Their own background', label: 'What they told us themselves' },
  { bg: '#e6eef4', from: 'Prefers region',       label: 'Where it went' },
  { bg: '#eef0f1', from: 'How they reached us',  label: 'The record' }
];

/** Long free text. Wide, and NOT wrapped — a wrapped CV summary makes a 200px tall row. */
var DETAIL_WIDE = [
  'Address', 'Education history', 'Work history', 'Skills', 'Languages', 'Certifications',
  'Professional summary', 'Their own background', 'Their own experience', 'Status note'
];

var DETAIL_WIDTHS = {
  '#': 46,
  'Candidate': 210,
  'Phone': 130,
  'Email': 210,
  'Governorate': 120,
  'Nationality': 100,
  'Gender': 80,
  'Date of birth': 110,
  'Marital status': 110,
  'Military status': 120,
  'LinkedIn': 90,
  'Faculty': 170,
  'University': 190,
  'Degree': 150,
  'Graduation year': 110,
  'Grade': 90,
  'Applied for': 180,
  'Current job title': 180,
  'Current employer': 180,
  'Years of experience': 110,
  'Worked before?': 100,
  'Medical rep before?': 120,
  'Medical rep employer': 180,
  'Salary they asked for': 130,
  'Expected salary (on file)': 140,
  'Notice period': 110,
  'English level': 110,
  'MS Office / Outlook': 130,
  'Booking experience': 130,
  'Can commute to Sheraton': 150,
  'Can start': 110,
  'Age band': 100,
  'Prefers region': 130,
  'Prefers area': 130,
  'Filed folder': 190,
  'Drive folder': 190,
  'Sent for job title': 170,
  'Sent for area': 130,
  'Sent for region': 130,
  'Sent for line': 110,
  'Manager notified': 160,
  'Manager notified at': 150,
  'How they reached us': 140,
  'Channel': 110,
  'CVs on file': 90,
  'Candidate status': 140,
  'Added to Phoenix': 150,
  'Open in Phoenix': 120
};

function writeDetail_(ss, rows, stamp) {
  // An older Phoenix that does not send #DETAIL must leave the tab alone rather than blank it.
  if (!rows.length) return false;
  var sheet = sheetFor_(ss, TAB_DETAIL);
  var header = rows[0];
  var body = rows.slice(1);

  var fresh = !layoutIsCurrent_(TAB_DETAIL, header);
  if (fresh) buildDetailLayout_(sheet, header);

  writeSubtitle_(sheet, TAB_DETAIL, stamp);

  clearDataBelow_(sheet, DETAIL_HEADER_ROW, header.length);
  if (body.length) {
    sheet.getRange(DETAIL_HEADER_ROW + 1, 1, body.length, header.length)
      .setValues(linkify_(header, body));
  }
  fitBody_(sheet, TAB_DETAIL, DETAIL_HEADER_ROW, header.length, body.length);

  if (fresh) markLayoutBuilt_(TAB_DETAIL, header);
  return fresh;
}

function buildDetailLayout_(sheet, header) {
  resetTab_(sheet);
  titleBand_(sheet, header.length, '  Everything Phoenix knows about each candidate');

  // titleBand_ leaves row 3 as a 10px spacer. Here it carries the group band instead.
  sheet.setRowHeight(3, 22);
  paintDetailGroups_(sheet, header);

  sheet.getRange(DETAIL_HEADER_ROW, 1, 1, header.length).setValues([header]);
  styleHeader_(sheet, DETAIL_HEADER_ROW, header.length);
  sheet.setFrozenRows(DETAIL_HEADER_ROW);
  // The number and the name stay on screen however far right he scrolls. With 58 columns that is
  // the difference between a usable table and a spreadsheet you get lost in.
  sheet.setFrozenColumns(2);

  applyDetailWidths_(sheet, header);
  applyDetailFormats_(sheet, header);
  applyDetailColours_(sheet, header);

  // A filter, so "show me everyone in Giza who has been a medical rep" is two clicks rather than a
  // request to me. This is the tab most worth filtering and the only one carrying those fields.
  if (!sheet.getFilter()) {
    sheet.getRange(DETAIL_HEADER_ROW, 1, sheet.getMaxRows() - DETAIL_HEADER_ROW + 1, header.length)
      .createFilter();
  }
}

function paintDetailGroups_(sheet, header) {
  var starts = [];
  for (var i = 0; i < DETAIL_GROUPS.length; i++) {
    var col = columnByName_(header, DETAIL_GROUPS[i].from);
    if (col > 0) starts.push({ col: col, group: DETAIL_GROUPS[i] });
  }
  for (var j = 0; j < starts.length; j++) {
    var from = starts[j].col;
    var to = (j + 1 < starts.length) ? starts[j + 1].col - 1 : header.length;
    if (to < from) continue;
    sheet.getRange(3, from, 1, to - from + 1).merge()
      .setValue(starts[j].group.label)
      .setBackground(starts[j].group.bg)
      .setFontColor(INK)
      .setFontWeight('bold')
      .setFontSize(10)
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle');
  }
}

function applyDetailWidths_(sheet, header) {
  for (var i = 0; i < header.length; i++) {
    var name = String(header[i]);
    var width = DETAIL_WIDTHS[name];
    if (width === undefined) width = DETAIL_WIDE.indexOf(name) >= 0 ? 320 : 140;
    sheet.setColumnWidth(i + 1, width);
  }
}

function applyDetailFormats_(sheet, header) {
  function format(name, pattern) {
    var c = columnByName_(header, name);
    if (c > 0) sheet.getRange(DETAIL_HEADER_ROW + 1, c, FIXED_RANGE_ROWS, 1).setNumberFormat(pattern);
  }

  // Plain text, or Sheets eats the leading zero and renders the number in scientific notation.
  format('Phone', '@');
  // '0' and not '#,##0': a graduation year is not a quantity, and 2,024 reads as a bug.
  format('Graduation year', '0');
  format('Years of experience', '#,##0');
  format('CVs on file', '#,##0');
  format('Salary they asked for', '#,##0');
  format('Expected salary (on file)', '#,##0');

  // The long text columns are clipped rather than wrapped. Clipping is NOT truncation — the whole
  // value is in the cell and shows in the formula bar and on click — and it is what keeps 741 rows
  // the same height. A wrapped work history is six lines tall and makes the table unreadable.
  for (var i = 0; i < DETAIL_WIDE.length; i++) {
    var c = columnByName_(header, DETAIL_WIDE[i]);
    if (c > 0) sheet.getRange(DETAIL_HEADER_ROW + 1, c, FIXED_RANGE_ROWS, 1).setWrap(false);
  }

  sheet.getRange(DETAIL_HEADER_ROW + 1, 1, FIXED_RANGE_ROWS, header.length)
    .setVerticalAlignment('middle');
}

function applyDetailColours_(sheet, header) {
  var rules = [];
  function range(name) {
    var c = columnByName_(header, name);
    return c > 0 ? sheet.getRange(DETAIL_HEADER_ROW + 1, c, FIXED_RANGE_ROWS, 1) : null;
  }

  // Experience the recruiter is actually hunting for, findable at a glance down the column.
  var medrep = range('Medical rep before?');
  if (medrep) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('Yes').setBackground(GOOD_BG).setFontColor(GOOD)
      .setRanges([medrep]).build());
  }
  var worked = range('Worked before?');
  if (worked) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('Yes').setBackground(GOOD_BG).setFontColor(GOOD)
      .setRanges([worked]).build());
  }

  // A candidate nobody has moved on yet.
  var status = range('Candidate status');
  if (status) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('new').setBackground(WARN_BG).setFontColor(WARN_FG)
      .setRanges([status]).build());
  }

  // A blank governorate is the one gap worth SEEING rather than glossing over: it is the field this
  // whole tab was rebuilt around, and a quiet blank is how the old sheet hid it for a month.
  var gov = range('Governorate');
  if (gov) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenCellEmpty().setBackground(BAD_BG)
      .setRanges([gov]).build());
  }

  if (rules.length) {
    sheet.setConditionalFormatRules(sheet.getConditionalFormatRules().concat(rules));
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
// Daily Dashboard
// ─────────────────────────────────────────────────────────────────────────────────

function writeDaily_(ss, rows, stamp) {
  if (!rows.length) return false;
  var sheet = sheetFor_(ss, TAB_DAILY);
  var header = rows[0];
  var body = rows.slice(1);

  var fresh = !layoutIsCurrent_(TAB_DAILY, header);
  if (fresh) buildDailyLayout_(sheet, header);

  writeSubtitle_(sheet, TAB_DAILY, stamp);

  clearDataBelow_(sheet, DAILY_HEADER_ROW, header.length);
  if (body.length) {
    sheet.getRange(DAILY_HEADER_ROW + 1, 1, body.length, header.length).setValues(body);
  }
  fitBody_(sheet, TAB_DAILY, DAILY_HEADER_ROW, header.length, body.length);

  if (fresh) markLayoutBuilt_(TAB_DAILY, header);
  return fresh;
}

function buildDailyLayout_(sheet, header) {
  resetTab_(sheet);
  titleBand_(sheet, header.length, '  CVs received each day, by channel');

  sheet.setColumnWidth(1, 120);
  for (var c = 2; c <= header.length; c++) sheet.setColumnWidth(c, 150);

  sheet.getRange(DAILY_HEADER_ROW, 1, 1, header.length).setValues([header]);
  styleHeader_(sheet, DAILY_HEADER_ROW, header.length);
  sheet.setFrozenRows(DAILY_HEADER_ROW);

  // Whole numbers. Without this a count of 7 can render as 7.00 once the column has ever held a
  // formatted value, which looks like a bug in the data.
  sheet.getRange(DAILY_HEADER_ROW + 1, 2, FIXED_RANGE_ROWS, header.length - 1).setNumberFormat('#,##0');

  applyDailyColours_(sheet, header);
  buildDailyChart_(sheet, header.length);
}

/**
 * The stacked column chart, built ONCE and never rebuilt.
 *
 * THE RANGE IS FIXED RATHER THAN SIZED TO THE DATA. A chart re-pointed at a growing range would
 * have to be rebuilt on every refresh — the exact churn this file exists to avoid — and a rebuilt
 * chart loses whatever position the reader dragged it to. Blank rows inside the range simply do
 * not plot, so an over-long range costs nothing but is stable for about three years of daily rows.
 */
function buildDailyChart_(sheet, cols) {
  var chart = sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    // Day, then the three channel columns — not the totals, which would double the height of every
    // bar and hide the split the chart exists to show.
    .addRange(sheet.getRange(DAILY_HEADER_ROW, 1, FIXED_RANGE_ROWS + 1, 4))
    // Anchored two columns PAST the table rather than above it. A chart placed above the data has
    // to have rows reserved under it, and reserved rows are indistinguishable from a broken sheet.
    .setPosition(DAILY_HEADER_ROW, cols + 2, 0, 0)
    .setOption('title', 'CVs received each day, by channel')
    .setOption('isStacked', true)
    .setOption('legend', { position: 'top' })
    .setOption('height', 300)
    .setOption('width', 1000)
    .setOption('colors', [C_WHATSAPP, C_EMAIL, C_HAND])
    .setOption('hAxis', { title: 'Day (Cairo)', slantedText: true, slantedTextAngle: 45 })
    .setOption('vAxis', { title: 'CVs', minValue: 0 })
    .build();
  sheet.insertChart(chart);
}

/** Green where the Drive mirror kept up, red where it did not. */
function applyDailyColours_(sheet, header) {
  var rules = [];
  var reached = columnByName_(header, 'Reached Google Drive');
  var missing = columnByName_(header, 'Still missing from Drive');
  var total = columnByName_(header, 'Total received');

  if (missing > 0) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0).setBackground(BAD_BG).setFontColor(BAD).setBold(true)
      .setRanges([sheet.getRange(DAILY_HEADER_ROW + 1, missing, FIXED_RANGE_ROWS, 1)])
      .build());
  }
  if (reached > 0) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0).setFontColor(GOOD)
      .setRanges([sheet.getRange(DAILY_HEADER_ROW + 1, reached, FIXED_RANGE_ROWS, 1)])
      .build());
  }
  if (total > 0) {
    // A gradient on the busiest days, so the eye finds them without reading every number.
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpoint(PAPER)
      .setGradientMaxpoint('#aec6f0')
      .setRanges([sheet.getRange(DAILY_HEADER_ROW + 1, total, FIXED_RANGE_ROWS, 1)])
      .build());
  }
  if (rules.length) sheet.setConditionalFormatRules(sheet.getConditionalFormatRules().concat(rules));
}

// ─────────────────────────────────────────────────────────────────────────────────
// CV Lifecycle — the table
// ─────────────────────────────────────────────────────────────────────────────────

/** Clear only the DATA, never the header or the band above it. */
/**
 * Stripe exactly as many rows as there is data, and no more.
 *
 * THE OTHER HALF OF THE "unfinished sheet" COMPLAINT. Banding a fixed 1000-row range leaves 970
 * empty striped rows under a Daily table that holds thirty days — a grey ladder running off the
 * bottom of the screen, which reads as a broken or half-loaded report rather than a finished one.
 *
 * This is the ONE thing a refresh is allowed to repaint, and it is deliberately gated on the row
 * COUNT rather than run every time: the count only moves when a new day or a new candidate appears,
 * so on the overwhelming majority of refreshes this function returns without touching the sheet.
 * The gate is what keeps "a refresh writes values and nothing else" true in practice.
 */
function fitBody_(sheet, key, headerRow, cols, rowCount) {
  var props = PropertiesService.getDocumentProperties();
  var storedKey = 'rows:' + key;
  if (props.getProperty(storedKey) === String(rowCount)) return;

  var bandings = sheet.getBandings();
  for (var i = 0; i < bandings.length; i++) bandings[i].remove();

  if (rowCount > 0) {
    sheet.getRange(headerRow + 1, 1, rowCount, cols)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  }
  props.setProperty(storedKey, String(rowCount));
}

function clearDataBelow_(sheet, headerRow, width) {
  var lastRow = sheet.getLastRow();
  if (lastRow > headerRow) {
    sheet.getRange(headerRow + 1, 1, lastRow - headerRow, Math.max(width, sheet.getLastColumn()))
      .clearContent();
  }
}

function writeLifecycle_(ss, rows, stamp) {
  var sheet = sheetFor_(ss, TAB_LIFECYCLE);
  var header = rows[0];
  var body = rows.slice(1);

  var fresh = !layoutIsCurrent_(TAB_LIFECYCLE, header);
  if (fresh) buildLifecycleLayout_(sheet, header);

  writeSubtitle_(sheet, TAB_LIFECYCLE, stamp);

  clearDataBelow_(sheet, LIFECYCLE_HEADER_ROW, header.length);
  if (body.length) {
    sheet.getRange(LIFECYCLE_HEADER_ROW + 1, 1, body.length, header.length)
      .setValues(linkify_(header, body));
  }

  if (fresh) markLayoutBuilt_(TAB_LIFECYCLE, header);
  return fresh;
}

/**
 * Turn the two URL columns into short clickable labels, and drop the phone's CSV prefix.
 *
 * A raw Drive URL is ninety characters of noise in a table meant to be scanned, and widening two
 * columns to fit one would push everything else off the screen. HYPERLINK is a VALUE, so this
 * still obeys the write-values-only rule — the columns' widths and formats are set once.
 */
function linkify_(header, body) {
  var driveCol = columnByName_(header, 'Open in Drive');
  var phoenixCol = columnByName_(header, 'Open in Phoenix');
  var phoneCol = columnByName_(header, 'Phone');
  var linkedinCol = columnByName_(header, 'LinkedIn');
  if (driveCol < 0 && phoenixCol < 0 && phoneCol < 0 && linkedinCol < 0) return body;

  function link(url, label) {
    var clean = String(url || '').trim();
    if (clean.indexOf('http') !== 0) return '';
    return '=HYPERLINK("' + clean.replace(/"/g, '""') + '","' + label + '")';
  }

  var out = [];
  for (var i = 0; i < body.length; i++) {
    var row = body[i].slice();
    if (driveCol > 0) row[driveCol - 1] = link(row[driveCol - 1], 'Open in Drive');
    if (phoenixCol > 0) row[phoenixCol - 1] = link(row[phoenixCol - 1], 'Open in Phoenix');
    // The feed prefixes the phone with an apostrophe so a CSV opened in Excel keeps the leading
    // zero and never turns +20… into scientific notation. This column is already plain text, so
    // the prefix would be one stray character in front of every number.
    if (phoneCol > 0) row[phoneCol - 1] = String(row[phoneCol - 1] || '').replace(/^'/, '');
    if (linkedinCol > 0) row[linkedinCol - 1] = link(row[linkedinCol - 1], 'LinkedIn');
    out.push(row);
  }
  return out;
}

function buildLifecycleLayout_(sheet, header) {
  resetTab_(sheet);
  titleBand_(sheet, header.length, '  Every CV, stage by stage');

  sheet.getRange(LIFECYCLE_HEADER_ROW, 1, 1, header.length).setValues([header]);
  styleHeader_(sheet, LIFECYCLE_HEADER_ROW, header.length);
  sheet.setFrozenRows(LIFECYCLE_HEADER_ROW);
  sheet.setFrozenColumns(2);

  applyLifecycleWidths_(sheet, header);

  var phone = columnByName_(header, 'Phone');
  if (phone > 0) {
    sheet.getRange(LIFECYCLE_HEADER_ROW + 1, phone, FIXED_RANGE_ROWS, 1).setNumberFormat('@');
  }
  var size = columnByName_(header, 'Size (KB)');
  if (size > 0) {
    sheet.getRange(LIFECYCLE_HEADER_ROW + 1, size, FIXED_RANGE_ROWS, 1).setNumberFormat('#,##0');
  }

  var dataRange = sheet.getRange(LIFECYCLE_HEADER_ROW + 1, 1, FIXED_RANGE_ROWS, header.length);
  dataRange.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  dataRange.setVerticalAlignment('middle');

  applyLifecycleColours_(sheet, header);

  if (!sheet.getFilter()) {
    sheet.getRange(LIFECYCLE_HEADER_ROW, 1, sheet.getMaxRows() - LIFECYCLE_HEADER_ROW + 1, header.length)
      .createFilter();
  }
}

/** Widths by column NAME, so inserting a column upstream cannot silently mis-size the sheet. */
function applyLifecycleWidths_(sheet, header) {
  var widths = {
    '#': 50,
    'Candidate': 220,
    'Phone': 140,
    'Channel': 120,
    'Sender / mailbox': 180,
    'Applied for': 180,
    'File': 240,
    'Size (KB)': 90,
    'Reached Phoenix': 150,
    'Accuracy of that time': 210,
    'Saved in Phoenix': 150,
    'In Phoenix?': 100,
    'Saved in Google Drive': 160,
    'On Google Drive?': 130,
    'Drive folder': 300,
    'Phoenix → Drive (minutes)': 150,
    'Drive problem': 240,
    'Intake status': 120,
    'Intake error': 240,
    'Applicant answered at': 160,
    'Filed folder': 220,
    'Region': 100,
    'Area': 160,
    'Candidate status': 140,
    'Open in Drive': 140,
    'Open in Phoenix': 150
  };
  for (var i = 0; i < header.length; i++) {
    var width = widths[String(header[i])];
    if (width) sheet.setColumnWidth(i + 1, width);
  }
}

/**
 * Colour is the whole point of a 980-row table: the eye should find the one bad row without
 * reading any of the good ones.
 *
 * Conditional rules rather than written colours: one rule instead of a per-row write on every
 * refresh, and they keep working as rows are added and removed underneath them.
 */
function applyLifecycleColours_(sheet, header) {
  var rules = [];
  var firstRow = LIFECYCLE_HEADER_ROW + 1;

  function colRange(name) {
    var index = columnByName_(header, name);
    return index > 0 ? sheet.getRange(firstRow, index, FIXED_RANGE_ROWS, 1) : null;
  }

  // Did it reach Google Drive? The question the sheet exists to answer.
  var drive = colRange('On Google Drive?');
  if (drive) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('Yes').setBackground(GOOD_BG).setFontColor(GOOD).setBold(true)
      .setRanges([drive]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('No').setBackground(BAD_BG).setFontColor(BAD).setBold(true)
      .setRanges([drive]).build());
  }

  var inPhoenix = colRange('In Phoenix?');
  if (inPhoenix) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('Yes').setFontColor(GOOD)
      .setRanges([inPhoenix]).build());
  }

  // Channel chips.
  var channel = colRange('Channel');
  if (channel) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('WhatsApp').setBackground(GOOD_BG).setFontColor(GOOD)
      .setRanges([channel]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('Email').setBackground('#e8f0fe').setFontColor('#1a56db')
      .setRanges([channel]).build());
  }

  // Anything that went wrong, in red, wherever it appears.
  var problems = ['Drive problem', 'Intake error'];
  for (var p = 0; p < problems.length; p++) {
    var range = colRange(problems[p]);
    if (!range) continue;
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenCellNotEmpty().setBackground(BAD_BG).setFontColor(BAD)
      .setRanges([range]).build());
  }

  // How long the mirror took: green when it was quick, red when it dragged.
  var minutes = colRange('Phoenix → Drive (minutes)');
  if (minutes) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpointWithValue(GOOD_BG, SpreadsheetApp.InterpolationType.NUMBER, '0')
      .setGradientMidpointWithValue(WARN_BG, SpreadsheetApp.InterpolationType.NUMBER, '60')
      .setGradientMaxpointWithValue(BAD_BG, SpreadsheetApp.InterpolationType.NUMBER, '1440')
      .setRanges([minutes]).build());
  }

  // A stamp that is not the webhook's own is worth seeing, but quietly — it is a precision note,
  // not a fault.
  var accuracy = colRange('Accuracy of that time');
  if (accuracy) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextDoesNotContain('Exact').setFontColor(MUTED).setItalic(true)
      .setRanges([accuracy]).build());
  }

  if (rules.length) sheet.setConditionalFormatRules(sheet.getConditionalFormatRules().concat(rules));
}

// ─────────────────────────────────────────────────────────────────────────────────
// Tab order
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Summary first, then the dashboard, then the table — and drop Google's empty starter tab.
 *
 * Only ever called on a rebuild: moveActiveSheet needs setActiveSheet, which would pull the reader
 * onto another tab. Doing that every five minutes would make the sheet unusable.
 */
function orderTabs_(ss) {
  for (var i = 0; i < TAB_ORDER.length; i++) {
    var sheet = ss.getSheetByName(TAB_ORDER[i]);
    if (!sheet) continue;
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(i + 1);
  }
  var starter = ss.getSheetByName('Sheet1');
  if (starter && ss.getSheets().length > 1 && starter.getLastRow() === 0) {
    ss.deleteSheet(starter);
  }
  var summary = ss.getSheetByName(TAB_SUMMARY);
  if (summary) ss.setActiveSheet(summary);
}
