/**
 * Phoenix Workforce — Marketing Requests live Google Sheet
 * ==================================================================================
 * Keeps the owner's Google Sheet in step with the share-link feed as a faithful copy of the
 * downloadable Marketing Request .xlsx — plus an Executive Summary panel, banded tables, a sticky TOTAL bar,
 * colour-coded status columns, and CLICKABLE evidence photos, invoices and transfer proofs.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * STABILITY IS THE GOVERNING CONSTRAINT. READ THIS BEFORE CHANGING ANYTHING.
 *
 * The first version of this sheet moved, resized and flickered while it was being read, because it
 * re-applied layout on every one-minute pull. A report you cannot rest your eyes on is not a report.
 * The rule now is absolute:
 *
 *     A REFRESH WRITES VALUES. IT TOUCHES NOTHING ELSE.
 *
 * Column widths, banding, conditional formatting, the filter, the frozen panes, the header and the
 * TOTAL bar are all built ONCE — on first run, or if the feed's column set ever changes — and are
 * never re-applied afterwards. Anything that reorders tabs, resizes a column or rebuilds a filter
 * on a routine refresh is a bug, however cosmetic it looks in isolation.
 *
 * Two design choices exist purely to make that possible:
 *
 *   1. THE TOTAL BAR SITS ABOVE THE DATA, not below it. A totals row underneath moves every time
 *      the row count changes, which forces a rewrite every refresh — the exact churn this file is
 *      built to avoid. Above the data it never moves, it stays inside the frozen panes so it is
 *      visible while you scroll, and it is outside the filter range so a reader can never filter
 *      away or sort the grand total. (The Direct Orders sheet had to learn that last one twice.)
 *
 *   2. EVERY RANGE IS FIXED, not sized to the data. Formulas, banding and conditional formats all
 *      span rows 5..2004 regardless of how many requests exist, so growth from 1 request to 500
 *      changes not one formatting call. SUBTOTAL and QUERY both ignore the empty tail.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IS IN HERE
 *   Executive Summary — one panel: KPI tiles, ROI health, breakdowns by line / status / region,
 *               the approval bottleneck, biggest spends, and an alert list. Every figure is a LIVE
 *               FORMULA over the Requests tab, so it stays right between refreshes and — more
 *               usefully — recalculates when you filter Requests, making it a lens on whatever
 *               slice you are looking at rather than a fixed company summary.
 *   Requests / Products / Approval trail / Pharmacies — banded tables, frozen header and first
 *               column, a filter, a sticky TOTAL bar, and colour-coded status columns.
 *   Cover     — provenance.
 *
 * WHY A SCRIPT AND NOT =IMPORTDATA
 *   IMPORTDATA refreshes on Google's own schedule — roughly hourly, not configurable — and can
 *   only ever produce one flat table. This runs on a 1-minute trigger, builds six tabs, and renders
 *   hyperlinks. Phoenix also PUSHES to doPost() the moment a request changes, so in practice the
 *   sheet is current within seconds.
 *
 * SETUP (once)
 *   1. Extensions -> Apps Script
 *   2. Delete the placeholder code, paste this file, Save
 *   3. Put your feed token in FEED_URL below
 *   4. Choose `installTrigger` in the function dropdown, click Run, authorise when Google asks
 *      (it is asking about YOUR OWN script)
 *   5. For instant refresh: Deploy -> New deployment -> Web app -> Execute as ME, Access ANYONE.
 *      Then Project Settings -> Script Properties -> add WEBHOOK_SECRET with the same value as
 *      MARKETING_SHEET_REFRESH_WEBHOOK_SECRET in Railway, and put the /exec URL in Railway's
 *      MARKETING_SHEET_REFRESH_WEBHOOK_URL.
 *
 * If you ever change the styling constants in this file, run `rebuildEverything` once from the
 * Phoenix menu. A normal refresh will NOT pick them up — by design.
 *
 * SECURITY
 *   FEED_URL contains a bearer token: anyone holding it can read every marketing request this
 *   link's scope covers, and open the evidence photographs. Keep the SHEET private and share the
 *   SHEET, never the URL. The token can be revoked server-side at any time, which instantly kills
 *   this script's access and every file link inside the sheet with it.
 *
 * FAIL-SAFE
 *   Nothing is cleared until a good response has been fetched AND parsed. A network blip, an
 *   expired token or a revoked link leaves the last good data on screen rather than blanking the
 *   report — a sheet that silently empties itself reads as "all the requests are gone", which is
 *   worse than stale data.
 */

// ── Configuration ────────────────────────────────────────────────────────────────
var FEED_URL =
  "https://phoenix-hr.satopharma.com/api/share/marketing-requests/" +
  "PASTE_YOUR_FEED_TOKEN_HERE" +
  "/feed";

var TZ = "Africa/Cairo";

/** Fixed geometry. Nothing here depends on how many rows the feed returns — see STABILITY above. */
var ROW_TITLE = 1;
var ROW_SUBTITLE = 2;
var ROW_TOTAL = 3;
var ROW_HEADER = 4;
var ROW_DATA = 5;
var MAX_DATA_ROWS = 2000;
var LAST_ROW = ROW_DATA + MAX_DATA_ROWS - 1;

// ── Phoenix brand palette ───────────────────────────────────────────────────────
var BLACK = "#000000";
var ORANGE = "#F97316";
var AMBER = "#FDE7C7";
var WHITE = "#FFFFFF";
var SLATE = "#334155";
var MUTED = "#94A3B8";
var INK = "#0F172A";
var HAIRLINE = "#E2E8F0";
var TILE_BG = "#FFF7ED";
var FONT = "Calibri";

/** Zebra pair — a very low-contrast warm tint, not Google's grey theme. The reader is scanning 109
 *  columns and a heavy stripe fights the conditional-format colours for attention. */
var ZEBRA_A = "#FFFFFF";
var ZEBRA_B = "#FFF8F1";
var TOTAL_BG = "#1F2937";

var UNITS_FMT = "#,##0";
var VALUE_FMT = "#,##0.00";
var PCT_FMT = "0.0%";

/** Columns holding numbers — they must arrive as numbers, not text, or the TOTAL bar reads zero. */
var NUMERIC = {
  "Serial": UNITS_FMT,
  "Amount": VALUE_FMT,
  "Estimated ROI": VALUE_FMT,
  "Required ROI": VALUE_FMT,
  "ROI coverage": PCT_FMT,
  "ROI duration (months)": UNITS_FMT,
  "Products": UNITS_FMT,
  "Pharmacies": UNITS_FMT,
  "Approval steps": UNITS_FMT,
  "Days to approve": "#,##0.0",
  "Customer GPS latitude": "0.000000",
  "Customer GPS longitude": "0.000000",
  "Customer GPS accuracy (m)": "#,##0.0",
  "Actual sales value": VALUE_FMT,
  "Actual sales units": UNITS_FMT,
  "Actual ROI coverage": PCT_FMT,
  "Coverage gap": VALUE_FMT,
  "Expected gap": VALUE_FMT,
  "Sales rows": UNITS_FMT,
  "Exact sales rows": UNITS_FMT,
  "Fallback sales rows": UNITS_FMT,
  "Factory price": VALUE_FMT,
  "Forecast quantity": UNITS_FMT,
  "Expected value": VALUE_FMT,
  "Share of ROI": PCT_FMT,
  "Step": UNITS_FMT,
  "Reference matches": UNITS_FMT,
  "GPS latitude": "0.000000",
  "GPS longitude": "0.000000",
  "GPS accuracy (m)": "#,##0.0"
};

/**
 * Columns whose value is a URL and must render as a CLICKABLE cell.
 *
 * A blank stays blank — deliberately. Writing "Open photo" over an empty URL produces a link that
 * goes nowhere, and a reader who clicks a dead link concludes the system lost the file rather than
 * that none was ever taken.
 */
var LINK_LABELS = {
  "Evidence photo link": "📷 Open photo",
  "Money transfer proof link": "🧾 Open proof",
  "Invoice link": "📄 Open invoice",
  "Request Preview": "↗ Open in Phoenix"
};

/** Which columns get a total, per tab. Money and quantity only — a total of "Days to approve" or a
 *  GPS coordinate is noise dressed up as a figure. */
var TOTALLED = {
  "Requests": ["Amount", "Estimated ROI", "Required ROI", "Actual sales value", "Coverage gap"],
  "Products": ["Forecast quantity", "Expected value"],
  "Approval trail": [],
  "Pharmacies": []
};

/** Every column that carries a state word, wherever it appears. */
var STATUS_COLUMNS = [
  "Status", "ROI status", "Actual ROI status", "Current step",
  "Customer evidence status", "Customer validation status",
  "Evidence status", "Validation status", "Tracking status", "Reference status",
  "Invoice status", "Attribution quality"
];

/**
 * Colour by MEANING, not by column: green reads "done and healthy", red "needs a decision", amber
 * "waiting on someone", blue "in flight", grey "parked". Applied to every status column so the same
 * word never means two different colours in two places.
 */
var STATUS_RULES = [
  { match: ["Approved", "Complete", "System validated", "Validated", "On target", "On track", "Exact customer", "Paid"], bg: "#DCFCE7", fg: "#166534" },
  { match: ["Rejected", "Under target", "Failed", "Missing", "No sales", "Unlinkable"], bg: "#FEE2E2", fg: "#991B1B" },
  { match: ["Returned", "Pending validation", "Pending", "Awaiting", "Finance hold", "Brick fallback", "Mixed"], bg: "#FEF3C7", fg: "#92400E" },
  { match: ["Pending approval", "In approval", "Roi tracking", "Active", "Submitted"], bg: "#DBEAFE", fg: "#1E40AF" },
  { match: ["Draft", "Archived", "Closed", "Skipped", "Not required"], bg: "#F1F5F9", fg: "#475569" }
];

var SECTIONS = [
  { key: "REQUESTS", tab: "Requests", subtitle: "Every field the system holds about each request" },
  { key: "PRODUCTS", tab: "Products", subtitle: "What each request's estimated ROI is built from" },
  { key: "APPROVALS", tab: "Approval trail", subtitle: "Every step, who decided it, and when" },
  { key: "PHARMACIES", tab: "Pharmacies", subtitle: "Where each request's sales are tracked" }
];

var EXEC_TAB = "Executive Summary";
/** What that panel was called before. Kept so an existing sheet is RENAMED, not duplicated. */
var LEGACY_EXEC_TAB = "God Mode";

var TAB_ORDER = [EXEC_TAB, "Requests", "Products", "Approval trail", "Pharmacies", "Cover"];

// ── Entry points ────────────────────────────────────────────────────────────────

/** Run once, by hand, to install the 1-minute trigger. Safe to re-run. */
function installTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) ScriptApp.deleteTrigger(existing[i]);
  ScriptApp.newTrigger("refreshMarketingRequests").timeBased().everyMinutes(1).create();
  rebuildEverything();
}

/**
 * Force a full redraw. The ONLY way layout changes reach an existing sheet, because a routine
 * refresh deliberately never touches formatting.
 */
function rebuildEverything() {
  PropertiesService.getScriptProperties().deleteProperty("layoutSignature");
  refreshMarketingRequests();
}

/**
 * Instant refresh, pushed by Phoenix the moment a request changes.
 *
 * The deployment must be reachable by "Anyone" because Phoenix calls it unauthenticated — so the
 * URL alone must not be enough. WEBHOOK_SECRET is what actually authorises; set it to the same
 * value as MARKETING_SHEET_REFRESH_WEBHOOK_SECRET in Railway. A leaked URL without the secret can
 * do nothing.
 */
function doPost(e) {
  var expected = PropertiesService.getScriptProperties().getProperty("WEBHOOK_SECRET");
  if (!expected) {
    // Fail CLOSED. An unset secret accepting everything would mean a fresh deployment silently
    // trusts any caller on the internet.
    return ContentService.createTextOutput("not configured").setMimeType(ContentService.MimeType.TEXT);
  }
  var supplied = "";
  try {
    supplied = String(JSON.parse(e && e.postData ? e.postData.contents : "{}").secret || "");
  } catch (err) {
    supplied = "";
  }
  // Deliberately vague: a caller learns whether they are authorised, never why not.
  if (supplied !== expected) {
    return ContentService.createTextOutput("denied").setMimeType(ContentService.MimeType.TEXT);
  }
  refreshMarketingRequests();
  return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Phoenix")
    .addItem("Refresh now", "refreshMarketingRequests")
    .addItem("Rebuild layout", "rebuildEverything")
    .addToUi();
}

// ── The refresh ─────────────────────────────────────────────────────────────────

function refreshMarketingRequests() {
  var response;
  try {
    response = UrlFetchApp.fetch(FEED_URL + "?bundle=1", { muteHttpExceptions: true });
  } catch (err) {
    return; // network blip — last good data stays on screen
  }
  if (response.getResponseCode() !== 200) return; // revoked / expired — same rule

  var bundle;
  try {
    bundle = parseBundle(response.getContentText());
  } catch (err) {
    return; // unparseable — never clear on a bad parse
  }
  if (!bundle || !bundle.REQUESTS || bundle.REQUESTS.length === 0) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  var stamp = Utilities.formatDate(new Date(), TZ, "dd MMM yyyy, HH:mm");

  // ONE signature decides whether any layout work happens at all. It covers every tab's column set,
  // so a feed that gains a column rebuilds everything, and a feed that has not changed rebuilds
  // nothing — which is every refresh but the first.
  var signature = buildLayoutSignature(bundle);
  var rebuild = props.getProperty("layoutSignature") !== signature;

  for (var i = 0; i < SECTIONS.length; i++) {
    var grid = bundle[SECTIONS[i].key];
    if (!grid || grid.length === 0) continue;
    writeGridSheet(ss, SECTIONS[i], grid, stamp, rebuild);
  }

  if (rebuild) {
    buildExecutiveSummarySheet(ss, bundle.REQUESTS[0], stamp);
    buildCoverSheet(ss, bundle.SUMMARY || [], stamp);
    orderTabs(ss, TAB_ORDER);
    props.setProperty("layoutSignature", signature);
  } else {
    // The only thing a routine refresh changes outside the data itself: the "as at" stamps.
    stampSheet(ss, EXEC_TAB, "Everything at a glance — refreshed " + stamp + " (Cairo)");
    stampSheet(ss, "Cover", "Live — refreshed " + stamp + " (Cairo)");
  }
}

/** Every tab's header row, joined. Changes only when the feed's shape changes. */
function buildLayoutSignature(bundle) {
  var parts = [];
  for (var i = 0; i < SECTIONS.length; i++) {
    var grid = bundle[SECTIONS[i].key];
    parts.push(SECTIONS[i].tab + ":" + (grid && grid.length > 0 ? grid[0].join("|") : ""));
  }
  return parts.join("‖");
}

/**
 * Split the one bundled response into its sections.
 *
 * The feed is ONE response with `#`-prefixed markers rather than five endpoints, so every tab
 * describes the same instant. Five sequential fetches could not promise that, and a Requests tab
 * showing a request whose Products tab has not caught up is the quiet inconsistency that destroys
 * trust in a report.
 */
function parseBundle(text) {
  var rows = parseCsv(text.replace(/^﻿/, ""));
  var out = {};
  var current = null;
  for (var i = 0; i < rows.length; i++) {
    var first = rows[i].length > 0 ? String(rows[i][0]) : "";
    if (first.charAt(0) === "#") {
      current = first.substring(1);
      out[current] = [];
    } else if (current) {
      out[current].push(rows[i]);
    }
  }
  return out;
}

/** RFC4180 CSV, including quoted fields containing commas and embedded newlines. */
function parseCsv(text) {
  var rows = [];
  var row = [];
  var field = "";
  var inQuotes = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}

// ── Data tabs ───────────────────────────────────────────────────────────────────

function writeGridSheet(ss, section, grid, stamp, rebuild) {
  var header = grid[0];
  var body = grid.slice(1);
  var cols = header.length;
  var sheet = ss.getSheetByName(section.tab);
  if (!sheet) {
    sheet = ss.insertSheet(section.tab);
    rebuild = true;
  }
  if (rebuild) buildGridFrame(sheet, section, header, cols);
  // Cheap guard, not layout: if someone deleted rows by hand, every getRange below would throw and
  // the tab would silently stop updating. One getMaxRows call a minute is nothing.
  ensureRows(sheet, LAST_ROW);

  // ── the only part that runs every minute ──
  if (body.length > 0) {
    var values = [];
    for (var r = 0; r < body.length && r < MAX_DATA_ROWS; r++) {
      var out = [];
      for (var c = 0; c < cols; c++) {
        var raw = body[r][c] === undefined ? "" : body[r][c];
        if (LINK_LABELS[header[c]]) {
          // A HYPERLINK formula is the only cell type that both shows a friendly label and
          // navigates on a single click.
          out.push(raw ? '=HYPERLINK("' + String(raw).replace(/"/g, '""') + '","' + LINK_LABELS[header[c]] + '")' : "");
        } else {
          out.push(coerce(header[c], raw));
        }
      }
      values.push(out);
    }
    sheet.getRange(ROW_DATA, 1, values.length, cols).setValues(values);
    // Clear only the tail below the new data. Formatting is untouched, so the cleared rows keep
    // their banding and stay ready for the next, longer refresh.
    var tail = LAST_ROW - (ROW_DATA + values.length) + 1;
    if (tail > 0) sheet.getRange(ROW_DATA + values.length, 1, tail, cols).clearContent();
  } else {
    sheet.getRange(ROW_DATA, 1, MAX_DATA_ROWS, cols).clearContent();
  }

  sheet.getRange(ROW_SUBTITLE, 1).setValue(section.subtitle + "   ·   refreshed " + stamp + " (Cairo)");
}

/**
 * Everything that is NOT data. Runs on first build and whenever the feed's column set changes —
 * never on a routine refresh.
 */
function buildGridFrame(sheet, section, header, cols) {
  resetSheet(sheet);
  ensureRows(sheet, LAST_ROW);

  bandTitle(sheet, cols, section.tab, section.subtitle);

  // ── the sticky TOTAL bar, ABOVE the data so it never moves ──
  var totalled = TOTALLED[section.tab] || [];
  var totalRange = sheet.getRange(ROW_TOTAL, 1, 1, cols);
  totalRange.setBackground(TOTAL_BG).setFontColor(WHITE).setFontFamily(FONT)
    .setFontWeight("bold").setFontSize(10.5).setVerticalAlignment("middle");
  sheet.setRowHeight(ROW_TOTAL, 28);
  sheet.getRange(ROW_TOTAL, 1).setValue(totalled.length > 0 ? "TOTAL ▸" : "");
  for (var t = 0; t < header.length; t++) {
    if (totalled.indexOf(String(header[t])) < 0) continue;
    var letter = columnLetter(t + 1);
    // SUBTOTAL(109) = sum, IGNORING rows hidden by the filter. Plain SUM would let a reader filter
    // to one line while the total still showed the whole company — wrong in the most convincing
    // possible way, because it is correct for a selection nobody made.
    sheet.getRange(ROW_TOTAL, t + 1)
      .setFormula("=SUBTOTAL(109," + letter + ROW_DATA + ":" + letter + LAST_ROW + ")")
      .setNumberFormat(NUMERIC[header[t]] || VALUE_FMT)
      .setHorizontalAlignment("right");
  }

  // ── header ──
  var headerRange = sheet.getRange(ROW_HEADER, 1, 1, cols);
  headerRange.setValues([header]);
  headerRange.setFontFamily(FONT).setFontSize(10.5).setFontWeight("bold").setFontColor(WHITE)
    .setBackground(INK).setVerticalAlignment("middle").setWrap(true)
    .setBorder(true, true, true, true, true, true, ORANGE, SpreadsheetApp.BorderStyle.SOLID);
  sheet.setRowHeight(ROW_HEADER, 36);

  // Band, total and header all stay on screen; the first column stays on screen sideways.
  sheet.setFrozenRows(ROW_HEADER);
  sheet.setFrozenColumns(1);

  // ── body formatting, over the FIXED range ──
  var body = sheet.getRange(ROW_DATA, 1, MAX_DATA_ROWS, cols);
  body.setFontFamily(FONT).setFontSize(10).setVerticalAlignment("middle");
  // Ruled cells. Native gridlines are hidden (setHiddenGridlines) so the brand band reads as a
  // solid header rather than a black area with grey lines through it — which means the table needs
  // its own rules or it has none at all. A hairline, not a hard line: at 109 columns a strong grid
  // turns into a wall of ink and the reader stops seeing the numbers.
  body.setBorder(true, true, true, true, true, true, HAIRLINE, SpreadsheetApp.BorderStyle.SOLID);
  for (var n = 0; n < header.length; n++) {
    var fmt = NUMERIC[header[n]];
    if (fmt) {
      sheet.getRange(ROW_DATA, n + 1, MAX_DATA_ROWS, 1).setNumberFormat(fmt).setHorizontalAlignment("right");
    }
  }

  applyZebra(sheet, cols);
  applyStatusColours(sheet, header);
  sizeColumns(sheet, header, cols);

  // The filter covers the header and the data — NEVER the TOTAL bar, which is why the bar sits
  // above. A totals row inside a filter range can be filtered out of existence or sorted into the
  // middle of the data.
  try {
    sheet.getRange(ROW_HEADER, 1, MAX_DATA_ROWS + 1, cols).createFilter();
  } catch (err) {
    // a filter already exists — cosmetic, never fail the build over it
  }
}

/**
 * Zebra striping as real BANDING, not per-row background fills.
 *
 * Banding is one sheet-level object: it costs a single call instead of one per row, and it
 * re-stripes itself as rows are filtered. Painted backgrounds look identical on the first draw and
 * then go wrong the moment anything is filtered, because the stripes stay with the ROWS rather than
 * with what is visible.
 */
function applyZebra(sheet, cols) {
  try {
    var existing = sheet.getBandings();
    for (var i = 0; i < existing.length; i++) existing[i].remove();
    var range = sheet.getRange(ROW_DATA, 1, MAX_DATA_ROWS, cols);
    range.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
    var banding = sheet.getBandings()[0];
    if (banding) banding.setFirstRowColor(ZEBRA_A).setSecondRowColor(ZEBRA_B);
  } catch (err) {
    // banding is cosmetic — never fail the build over it
  }
}

/**
 * Colour every status column by meaning.
 *
 * Rules are set in ONE call: setConditionalFormatRules REPLACES the whole list, so building them up
 * per column would leave only the last column coloured — a bug that presents as "conditional
 * formatting randomly stopped working".
 */
function applyStatusColours(sheet, header) {
  var ranges = [];
  for (var i = 0; i < header.length; i++) {
    if (STATUS_COLUMNS.indexOf(String(header[i])) >= 0) {
      ranges.push(sheet.getRange(ROW_DATA, i + 1, MAX_DATA_ROWS, 1));
    }
  }
  if (ranges.length === 0) {
    sheet.setConditionalFormatRules([]);
    return;
  }
  var rules = [];
  for (var r = 0; r < STATUS_RULES.length; r++) {
    for (var m = 0; m < STATUS_RULES[r].match.length; m++) {
      rules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenTextEqualTo(STATUS_RULES[r].match[m])
          .setBackground(STATUS_RULES[r].bg)
          .setFontColor(STATUS_RULES[r].fg)
          .setRanges(ranges)
          .build()
      );
    }
  }
  sheet.setConditionalFormatRules(rules);
}

// ── Executive Summary ────────────────────────────────────────────────────────────────────

/**
 * The one tab to look at.
 *
 * Built ONCE. Every figure is a live formula over the Requests tab, never a value this script
 * computed and pasted — so it needs no refresh of its own, it stays right in the minute between
 * pulls, and it recalculates when the reader filters Requests. That last property is what makes it
 * a lens rather than a summary: filter Requests to one line and this panel reports that line.
 */
function buildExecutiveSummarySheet(ss, header, stamp) {
  var sheet = ss.getSheetByName(EXEC_TAB);
  if (!sheet) {
    // This panel shipped as "God Mode" first. RENAME the existing tab rather than inserting a new
    // one beside it: creating a fresh tab would leave the old one behind, frozen at whatever it
    // last showed, and a stale board panel that still looks live is worse than no panel at all.
    var legacy = ss.getSheetByName(LEGACY_EXEC_TAB);
    if (legacy) {
      legacy.setName(EXEC_TAB);
      sheet = legacy;
    } else {
      sheet = ss.insertSheet(EXEC_TAB);
    }
  }
  resetSheet(sheet);
  ensureRows(sheet, 120);

  var Q = "'Requests'!";
  function rangeOf(label) {
    var index = header.indexOf(label);
    if (index < 0) return null;
    var letter = columnLetter(index + 1);
    return Q + letter + ROW_DATA + ":" + letter + LAST_ROW;
  }
  var rStatus = rangeOf("Status");
  var rAmount = rangeOf("Amount");
  var rRoi = rangeOf("Estimated ROI");
  var rRequired = rangeOf("Required ROI");
  var rRoiStatus = rangeOf("ROI status");
  var rCode = rangeOf("Request code");
  var rDays = rangeOf("Days to approve");
  var rInvoice = rangeOf("Invoice file");
  var rProof = rangeOf("Money transfer proof file");

  sheet.setColumnWidth(1, 28);
  sheet.setColumnWidth(2, 260);
  for (var w = 3; w <= 9; w++) sheet.setColumnWidth(w, 155);

  bandTitle(sheet, 9, EXEC_TAB, "Everything at a glance — refreshed " + stamp + " (Cairo)");
  sheet.setFrozenRows(2);

  var row = 4;

  row = tileRow(sheet, row, [
    { label: "Requests", formula: rCode ? "=COUNTA(" + rCode + ")" : "=0", fmt: UNITS_FMT },
    { label: "Total spend (EGP)", formula: rAmount ? "=SUM(" + rAmount + ")" : "=0", fmt: VALUE_FMT },
    { label: "Estimated ROI (EGP)", formula: rRoi ? "=SUM(" + rRoi + ")" : "=0", fmt: VALUE_FMT },
    { label: "Required ROI (EGP)", formula: rRequired ? "=SUM(" + rRequired + ")" : "=0", fmt: VALUE_FMT }
  ]);

  row = tileRow(sheet, row, [
    {
      label: "ROI coverage",
      // IFERROR, not a bare divide: with nothing to require, the denominator is zero and a raw
      // #DIV/0! on the headline tile makes the whole panel look broken.
      formula: (rRoi && rRequired) ? "=IFERROR(SUM(" + rRoi + ")/SUM(" + rRequired + "),0)" : "=0",
      fmt: PCT_FMT
    },
    { label: "Approved", formula: rStatus ? '=COUNTIF(' + rStatus + ',"Approved")' : "=0", fmt: UNITS_FMT },
    { label: "Under ROI target", formula: rRoiStatus ? '=COUNTIF(' + rRoiStatus + ',"Under target")' : "=0", fmt: UNITS_FMT },
    { label: "Avg days to approve", formula: rDays ? "=IFERROR(AVERAGE(" + rDays + "),0)" : "=0", fmt: "#,##0.0" }
  ]);

  row = sectionTitle(sheet, row, "Where the money goes");
  row = queryBlock(sheet, row, "By line", ["Line", "Requests", "Spend (EGP)", "Est. ROI (EGP)"],
    groupFormula(header, "Line", "Amount", "Estimated ROI"));
  row = queryBlock(sheet, row, "By region", ["Region", "Requests", "Spend (EGP)", "Est. ROI (EGP)"],
    groupFormula(header, "Region", "Amount", "Estimated ROI"));

  row = sectionTitle(sheet, row, "Where the work is stuck");
  row = queryBlock(sheet, row, "By status", ["Status", "Requests", "Spend (EGP)", "Est. ROI (EGP)"],
    groupFormula(header, "Status", "Amount", "Estimated ROI"));
  row = queryBlock(sheet, row, "Waiting on which step", ["Current step", "Requests", "Spend (EGP)", "Est. ROI (EGP)"],
    groupFormula(header, "Current step", "Amount", "Estimated ROI"));

  row = sectionTitle(sheet, row, "Biggest requests");
  row = queryBlock(sheet, row, "Top 10 by amount",
    ["Request", "Account / Dr.", "Amount (EGP)", "Est. ROI (EGP)", "Status"],
    topFormula(header));

  row = sectionTitle(sheet, row, "Needs attention");
  var alertFirstRow = row;
  var alerts = [
    ["Requests under their ROI target", rRoiStatus ? '=COUNTIF(' + rRoiStatus + ',"Under target")' : "=0"],
    ["Approved with no money-transfer proof on file", (rStatus && rProof) ? '=COUNTIFS(' + rStatus + ',"Approved",' + rProof + ',"")' : "=0"],
    ["Approved with no invoice on file", (rStatus && rInvoice) ? '=COUNTIFS(' + rStatus + ',"Approved",' + rInvoice + ',"")' : "=0"],
    ["Returned to the requester", rStatus ? '=COUNTIF(' + rStatus + ',"Returned")' : "=0"],
    ["Rejected", rStatus ? '=COUNTIF(' + rStatus + ',"Rejected")' : "=0"]
  ];
  for (var a = 0; a < alerts.length; a++) {
    sheet.getRange(row, 2).setValue(alerts[a][0])
      .setFontFamily(FONT).setFontSize(10.5).setFontColor(SLATE);
    sheet.getRange(row, 3).setFormula(alerts[a][1]).setNumberFormat(UNITS_FMT)
      .setFontFamily(FONT).setFontWeight("bold").setHorizontalAlignment("left");
    sheet.getRange(row, 2, 1, 2).setBorder(null, null, true, null, null, null, HAIRLINE, SpreadsheetApp.BorderStyle.SOLID);
    row++;
  }
  // Non-zero turns red; zero stays quiet. A panel where every line is red all the time is a panel
  // nobody reads.
  try {
    sheet.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenNumberGreaterThan(0)
        .setBackground("#FEE2E2").setFontColor("#991B1B").setBold(true)
        .setRanges([sheet.getRange(alertFirstRow, 3, alerts.length, 1)])
        .build()
    ]);
  } catch (err) {
    // cosmetic
  }

  row += 2;
  sheet.getRange(row, 2)
    .setValue("Every figure here is a live formula over the Requests tab — filter that tab and this panel follows it.")
    .setFontColor(MUTED).setFontStyle("italic").setFontFamily(FONT).setFontSize(10);
}

/** Four KPI tiles across: big number, small label under it. */
function tileRow(sheet, row, tiles) {
  for (var i = 0; i < tiles.length; i++) {
    var c = 2 + i * 2;
    sheet.getRange(row, c, 2, 2).setBackground(TILE_BG)
      .setBorder(true, true, true, true, false, false, AMBER, SpreadsheetApp.BorderStyle.SOLID);
    sheet.getRange(row, c).setFormula(tiles[i].formula).setNumberFormat(tiles[i].fmt)
      .setFontFamily(FONT).setFontSize(20).setFontWeight("bold").setFontColor(INK)
      .setVerticalAlignment("bottom");
    sheet.getRange(row + 1, c).setValue(tiles[i].label)
      .setFontFamily(FONT).setFontSize(9.5).setFontColor(SLATE).setVerticalAlignment("top");
  }
  sheet.setRowHeight(row, 36);
  sheet.setRowHeight(row + 1, 20);
  return row + 3;
}

function sectionTitle(sheet, row, title) {
  sheet.getRange(row, 2, 1, 8).setBackground(INK);
  sheet.getRange(row, 2).setValue(title)
    .setFontFamily(FONT).setFontSize(12).setFontWeight("bold").setFontColor(ORANGE);
  sheet.setRowHeight(row, 26);
  return row + 2;
}

/**
 * One breakdown: a caption, a header row, then a single formula that SPILLS its result.
 *
 * A spilling QUERY rather than script-written values, so the block grows and shrinks with the data
 * on its own — three lines today, forty next quarter, with no layout change and no risk of the
 * script leaving last month's longer table half-erased underneath this month's shorter one.
 */
function queryBlock(sheet, row, caption, headers, formula) {
  sheet.getRange(row, 2).setValue(caption)
    .setFontFamily(FONT).setFontSize(10.5).setFontWeight("bold").setFontColor(SLATE);
  row++;
  sheet.getRange(row, 2, 1, headers.length).setValues([headers])
    .setBackground("#F1F5F9").setFontFamily(FONT).setFontSize(9.5).setFontWeight("bold")
    .setFontColor(SLATE)
    .setBorder(null, null, true, null, null, null, HAIRLINE, SpreadsheetApp.BorderStyle.SOLID);
  row++;
  sheet.getRange(row, 2).setFormula(formula);
  sheet.getRange(row, 2, 12, headers.length).setFontFamily(FONT).setFontSize(10);
  sheet.getRange(row, 3, 12, 1).setNumberFormat(UNITS_FMT);
  sheet.getRange(row, 4, 12, 2).setNumberFormat(VALUE_FMT);
  return row + 13;
}

/** GROUP BY one column, counting rows and summing two money columns, biggest spend first. */
function groupFormula(header, groupLabel, sumA, sumB) {
  var Q = "'Requests'!";
  function span(label) {
    var index = header.indexOf(label);
    if (index < 0) return null;
    var letter = columnLetter(index + 1);
    return Q + letter + ROW_DATA + ":" + letter + LAST_ROW;
  }
  var g = span(groupLabel), a = span(sumA), b = span(sumB);
  if (!g || !a || !b) return '="—"';
  // "is not null" drops the empty tail of the fixed range, which would otherwise show up as a
  // nameless group holding a total the reader cannot act on.
  return '=IFERROR(QUERY({' + g + "," + a + "," + b + '},'
    + '"select Col1, count(Col2), sum(Col2), sum(Col3) where Col1 is not null '
    + "group by Col1 order by sum(Col2) desc "
    + "label count(Col2) '', sum(Col2) '', sum(Col3) ''\",0),\"—\")";
}

/** The ten biggest requests, with enough context to act on one. */
function topFormula(header) {
  var Q = "'Requests'!";
  function span(label) {
    var index = header.indexOf(label);
    if (index < 0) return null;
    var letter = columnLetter(index + 1);
    return Q + letter + ROW_DATA + ":" + letter + LAST_ROW;
  }
  var code = span("Request code"), acct = span("Account/Dr.Name"),
    amt = span("Amount"), roi = span("Estimated ROI"), stat = span("Status");
  if (!code || !acct || !amt || !roi || !stat) return '="—"';
  return '=IFERROR(QUERY({' + code + "," + acct + "," + amt + "," + roi + "," + stat + '},'
    + '"select * where Col1 is not null order by Col3 desc limit 10",0),"—")';
}

// ── Cover ───────────────────────────────────────────────────────────────────────

function buildCoverSheet(ss, summary, stamp) {
  var sheet = ss.getSheetByName("Cover");
  if (!sheet) sheet = ss.insertSheet("Cover");
  resetSheet(sheet);
  bandTitle(sheet, 2, "Marketing Request Report", "Live — refreshed " + stamp + " (Cairo)");
  sheet.setColumnWidth(1, 320);
  sheet.setColumnWidth(2, 520);

  sheet.getRange(3, 1, 1, 2).setBackground(AMBER);
  sheet.getRange(3, 1)
    .setValue("CONFIDENTIAL — marketing spend, customer identities, GPS capture and the full approval trail. Internal distribution only.")
    .setFontColor("#B45309").setFontWeight("bold").setFontFamily(FONT);
  sheet.setRowHeight(3, 26);

  var row = 5;
  for (var i = 0; i < summary.length; i++) {
    if (summary[i].length < 2) continue;
    sheet.getRange(row, 1).setValue(summary[i][0]).setFontWeight("bold").setFontColor(SLATE).setFontFamily(FONT);
    sheet.getRange(row, 2).setValue(summary[i][1]).setFontColor(SLATE).setFontFamily(FONT);
    row++;
  }
  sheet.getRange(row + 1, 1)
    .setValue("Refreshes every minute, and instantly whenever a request changes.")
    .setFontColor(MUTED).setFontStyle("italic").setFontFamily(FONT);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** Update only the "as at" line on a tab that is otherwise never touched by a refresh. */
function stampSheet(ss, name, text) {
  var sheet = ss.getSheetByName(name);
  if (sheet) sheet.getRange(ROW_SUBTITLE, 1).setValue(text);
}

function ensureRows(sheet, needed) {
  var have = sheet.getMaxRows();
  if (have < needed) sheet.insertRowsAfter(have, needed - have);
}

function resetSheet(sheet) {
  // clear() wipes content and formats but NOT merges, filters, banding or conditional-format rules,
  // so a sheet built by an earlier version keeps all four forever — and a merged brand band in
  // particular is exactly what makes setFrozenColumns throw. Strip them first, or a fix in this
  // file never reaches an existing sheet.
  try {
    var filter = sheet.getFilter();
    if (filter) filter.remove();
  } catch (err) { /* none */ }
  try {
    var bandings = sheet.getBandings();
    for (var i = 0; i < bandings.length; i++) bandings[i].remove();
  } catch (err) { /* none */ }
  try {
    sheet.setConditionalFormatRules([]);
  } catch (err) { /* none */ }
  try {
    sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 1), Math.max(sheet.getMaxColumns(), 1)).breakApart();
  } catch (err) { /* no merges to break */ }
  sheet.setFrozenRows(0);
  sheet.setFrozenColumns(0);
  sheet.clear();
  sheet.setHiddenGridlines(true);
}

/**
 * The two-row brand band, painted rather than MERGED.
 *
 * Merging row 1 across all columns makes Google refuse setFrozenColumns(1) — "you can't freeze
 * columns which contain only part of a merged cell" — because a boundary at column 1 bisects a
 * range spanning 109 of them. The Direct Orders sheet answered that by dropping the frozen column,
 * which costs the reader the request code the moment they scroll right.
 *
 * Painting the row's BACKGROUND and putting the text in an unmerged A1 looks identical: the
 * adjacent band cells are empty, so the title overflows across them the way any long cell does.
 */
function bandTitle(sheet, cols, title, subtitle) {
  sheet.getRange(ROW_TITLE, 1, 1, cols).setBackground(BLACK);
  sheet.getRange(ROW_TITLE, 1).setValue("Phoenix Workforce — " + title)
    .setFontColor(ORANGE).setFontWeight("bold").setFontSize(16)
    .setFontFamily(FONT).setVerticalAlignment("middle");
  sheet.setRowHeight(ROW_TITLE, 38);

  sheet.getRange(ROW_SUBTITLE, 1, 1, cols).setBackground(BLACK);
  sheet.getRange(ROW_SUBTITLE, 1).setValue(subtitle)
    .setFontColor(MUTED).setFontStyle("italic").setFontSize(10)
    .setFontFamily(FONT).setVerticalAlignment("middle");
  sheet.setRowHeight(ROW_SUBTITLE, 20);
}

/** A numeric column must arrive as a NUMBER or the TOTAL bar silently reads zero. */
function coerce(label, raw) {
  if (NUMERIC[label] && raw !== "" && raw !== null) {
    var parsed = Number(raw);
    if (!isNaN(parsed)) return parsed;
  }
  return raw;
}

/**
 * Widths are set once, from the header, and never auto-resized.
 *
 * autoResize on every pull is what made the Direct Orders sheet unreadable — columns visibly
 * jumping while the reader's eye was on them. The owner's rule is also that text must never wrap or
 * be truncated, so these are generous rather than tight.
 */
function sizeColumns(sheet, header, cols) {
  for (var i = 0; i < cols; i++) {
    var label = String(header[i]);
    var lower = label.toLowerCase();
    var width = 132;
    if (label === "Serial" || label === "Step" || label === "Week") width = 66;
    else if (lower.indexOf("link") >= 0 || label === "Request Preview") width = 148;
    else if (lower.indexOf("address") >= 0 || lower.indexOf("notes") >= 0) width = 320;
    else if (lower.indexOf("name") >= 0 || label.indexOf("Requester") === 0 || label.indexOf("Manager") === 0) width = 224;
    else if (label.length > 22) width = 208;
    sheet.setColumnWidth(i + 1, width);
  }
}

function columnLetter(index) {
  var letter = "";
  var n = index;
  while (n > 0) {
    var rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/**
 * Put the tabs in a stable order WITHOUT stranding the reader.
 *
 * moveActiveSheet is the only reordering API, so the active sheet is saved and restored around it.
 * Skipping that is what once yanked the viewer off whatever tab they had open. This runs only on a
 * rebuild, never on a routine refresh.
 */
function orderTabs(ss, names) {
  var previous = ss.getActiveSheet();
  for (var i = 0; i < names.length; i++) {
    var sheet = ss.getSheetByName(names[i]);
    if (!sheet) continue;
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(i + 1);
  }
  if (previous) ss.setActiveSheet(previous);
}
