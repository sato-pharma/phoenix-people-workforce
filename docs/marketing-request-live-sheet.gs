/**
 * Phoenix Workforce — Marketing Requests live Google Sheet
 * ==================================================================================
 * Keeps the owner's Google Sheet in step with the share-link feed as a faithful copy of the
 * downloadable Marketing Request .xlsx: the same tabs, the same columns, the same styling — plus
 * three CLICKABLE cells per request (evidence photo, money-transfer proof, invoice) that open the
 * file itself rather than showing a filename nobody can do anything with.
 *
 * STRUCTURE ONCE, VALUES EVERY MINUTE
 *   The layout is rebuilt only when it is actually wrong — first run, or the column set changed.
 *   Every other refresh writes VALUES ONLY. The Direct Orders sheet's first version rebuilt
 *   everything each minute and was unusable for it: a visible flicker as it cleared and redrew,
 *   columns resizing while you read, and setActiveSheet yanking the viewer off whatever tab they
 *   had open, once a minute. That mistake is not repeated here.
 *
 * WHY A SCRIPT AND NOT =IMPORTDATA
 *   IMPORTDATA refreshes on Google's own schedule — roughly hourly, not configurable — and can
 *   only ever produce one flat table. This runs on a 1-minute trigger, builds five tabs, and
 *   renders hyperlinks. Phoenix also PUSHES to doPost() below the moment a request changes, so in
 *   practice the sheet is current within seconds, not a minute.
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
 * SECURITY
 *   FEED_URL contains a bearer token: anyone holding it can read every marketing request this
 *   link's scope covers, and — if the link was minted with file access — open the evidence
 *   photographs too. Keep the SHEET private and share the SHEET, never the URL. The token can be
 *   revoked server-side at any time, which instantly kills this script's access and every file
 *   link inside the sheet with it.
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

// ── Phoenix brand palette (exactly the .xlsx export's colours) ───────────────────
var BLACK = "#000000";
var ORANGE = "#F97316";
var AMBER = "#FDE7C7";
var WHITE = "#FFFFFF";
var SLATE = "#334155";
var MUTED = "#94A3B8";
var ZEBRA = "#F8FAFC";
var GRID = "#F8B56B";
var FONT = "Calibri";

var UNITS_FMT = "#,##0";
var VALUE_FMT = "#,##0.00";
var PCT_FMT = "0.0%";

/** Columns holding numbers — they must arrive as numbers, not text, or totals break. */
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
 * Columns whose value is a URL and must render as a CLICKABLE cell (the owner's ask: "when I click
 * the photo it opens"). The label is what the reader sees; the URL is the target.
 *
 * A blank cell stays blank — deliberately. Writing "Open photo" over an empty URL would produce a
 * link that goes nowhere, and a reader who clicks a dead link concludes the system lost the file
 * rather than that none was ever taken.
 */
var LINK_LABELS = {
  "Evidence photo link": "📷 Open photo",
  "Money transfer proof link": "🧾 Open proof",
  "Invoice link": "📄 Open invoice",
  "Request Preview": "↗ Open in Phoenix"
};

/** The tabs, in the order they should sit, keyed by the feed's section marker. */
var SECTIONS = [
  { key: "REQUESTS", tab: "Requests", subtitle: "Every field the system holds about each request" },
  { key: "PRODUCTS", tab: "Products", subtitle: "What each request's estimated ROI is built from" },
  { key: "APPROVALS", tab: "Approval trail", subtitle: "Every step, who decided it, and when" },
  { key: "PHARMACIES", tab: "Pharmacies", subtitle: "Where each request's sales are tracked" }
];

// ── Entry points ────────────────────────────────────────────────────────────────

/** Run once, by hand, to install the 1-minute trigger. Safe to re-run. */
function installTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) ScriptApp.deleteTrigger(existing[i]);
  ScriptApp.newTrigger("refreshMarketingRequests").timeBased().everyMinutes(1).create();
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
    // Refuse rather than accept everything. An unset secret must fail CLOSED — the opposite would
    // mean a fresh deployment silently accepts any caller on the internet.
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

/** Adds a Phoenix menu so a refresh can also be forced by hand. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Phoenix")
    .addItem("Refresh now", "refreshMarketingRequests")
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
  if (!bundle || !bundle.REQUESTS) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var stamp = Utilities.formatDate(new Date(), TZ, "dd MMM yyyy, HH:mm");
  var created = [];

  for (var i = 0; i < SECTIONS.length; i++) {
    var section = SECTIONS[i];
    var grid = bundle[section.key];
    if (!grid || grid.length === 0) continue;
    buildGridSheet(ss, section, grid, stamp, created);
  }

  buildCoverSheet(ss, bundle.SUMMARY || [], stamp, created);
  orderTabs(ss, ["Cover", "Requests", "Products", "Approval trail", "Pharmacies"]);
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
  // Drop the trailing empty row a terminating newline leaves behind.
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}

// ── Sheet building ──────────────────────────────────────────────────────────────

function buildGridSheet(ss, section, grid, stamp, created) {
  var header = grid[0];
  var body = grid.slice(1);
  var sheet = getOrCreateSheet(ss, section.tab, created);
  var cols = header.length;

  // Only redraw the frame when the shape actually changed. See STRUCTURE ONCE above.
  var needsStructure = created.indexOf(section.tab) >= 0 || !headerMatches(sheet, header);
  if (needsStructure) {
    resetSheet(sheet);
    bandTitle(sheet, cols, section.tab, section.subtitle);
    var headerRange = sheet.getRange(3, 1, 1, cols);
    headerRange.setValues([header]);
    headerRange.setFontFamily(FONT).setFontWeight("bold").setFontColor(WHITE)
      .setBackground(BLACK).setVerticalAlignment("middle").setWrap(true);
    sheet.setFrozenRows(3);
    sheet.setFrozenColumns(1);
    sheet.getRange(3, 1, 1, cols).setBorder(true, true, true, true, true, true, GRID, SpreadsheetApp.BorderStyle.SOLID);
  }

  // Clear only the old body, never the frame — and only now, with good data in hand.
  var lastRow = sheet.getMaxRows();
  if (lastRow > 3) sheet.getRange(4, 1, lastRow - 3, sheet.getMaxColumns()).clearContent();

  if (body.length > 0) {
    var linkCols = {};
    for (var c = 0; c < header.length; c++) {
      if (LINK_LABELS[header[c]]) linkCols[c] = LINK_LABELS[header[c]];
    }

    var values = [];
    for (var r = 0; r < body.length; r++) {
      var out = [];
      for (var c2 = 0; c2 < cols; c2++) {
        var raw = body[r][c2] === undefined ? "" : body[r][c2];
        if (linkCols[c2] !== undefined) {
          // The owner's ask: clicking opens the file. A HYPERLINK formula is the only cell type
          // that both shows a friendly label and navigates on a single click.
          out.push(raw ? '=HYPERLINK("' + String(raw).replace(/"/g, '""') + '","' + linkCols[c2] + '")' : "");
        } else {
          out.push(coerce(header[c2], raw));
        }
      }
      values.push(out);
    }
    sheet.getRange(4, 1, values.length, cols).setValues(values);
    sheet.getRange(4, 1, values.length, cols).setFontFamily(FONT).setFontSize(10);
    applyColumnFormats(sheet, header, 4, values.length);
    // Zebra striping, applied as banding rather than per-row fills so it survives a value-only
    // refresh without being rewritten every minute.
    if (needsStructure) {
      try {
        var existing = sheet.getBandings();
        for (var b = 0; b < existing.length; b++) existing[b].remove();
        sheet.getRange(3, 1, Math.max(values.length + 1, 2), cols)
          .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
      } catch (err) {
        // banding is cosmetic — never fail the refresh over it
      }
    }
  }

  if (needsStructure) sizeColumns(sheet, header, cols);
  sheet.getRange(2, 1).setValue(section.subtitle + "   ·   refreshed " + stamp + " (Cairo)");
}

function buildCoverSheet(ss, summary, stamp, created) {
  var sheet = getOrCreateSheet(ss, "Cover", created);
  resetSheet(sheet);
  bandTitle(sheet, 2, "Marketing Request Report", "Live — refreshed " + stamp + " (Cairo)");
  sheet.setColumnWidth(1, 320);
  sheet.setColumnWidth(2, 520);

  var note = sheet.getRange(3, 1, 1, 2);
  note.merge();
  note.setValue("CONFIDENTIAL — marketing spend, customer identities, GPS capture and the full approval trail. Internal distribution only.");
  note.setBackground(AMBER).setFontColor("#B45309").setFontWeight("bold").setFontFamily(FONT).setWrap(true);

  var row = 5;
  for (var i = 0; i < summary.length; i++) {
    if (summary[i].length < 2) continue;
    sheet.getRange(row, 1).setValue(summary[i][0]).setFontWeight("bold").setFontColor(SLATE).setFontFamily(FONT);
    sheet.getRange(row, 2).setValue(summary[i][1]).setFontColor(SLATE).setFontFamily(FONT);
    row++;
  }
  sheet.getRange(row + 1, 1).setValue("Refreshes every minute, and instantly whenever a request changes.")
    .setFontColor(MUTED).setFontStyle("italic").setFontFamily(FONT);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function getOrCreateSheet(ss, name, created) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    created.push(name);
  }
  return sheet;
}

function resetSheet(sheet) {
  sheet.clear();
  sheet.setHiddenGridlines(true);
}

/** Has the column set changed since the frame was drawn? Values-only refresh depends on this. */
function headerMatches(sheet, header) {
  if (sheet.getLastRow() < 3) return false;
  var existing = sheet.getRange(3, 1, 1, header.length).getValues()[0];
  for (var i = 0; i < header.length; i++) {
    if (String(existing[i]) !== String(header[i])) return false;
  }
  return true;
}

function bandTitle(sheet, cols, title, subtitle) {
  var titleRange = sheet.getRange(1, 1, 1, cols);
  titleRange.merge();
  titleRange.setValue("Phoenix Workforce — " + title);
  titleRange.setBackground(BLACK).setFontColor(ORANGE).setFontWeight("bold").setFontSize(16)
    .setFontFamily(FONT).setVerticalAlignment("middle");
  sheet.setRowHeight(1, 34);

  var subRange = sheet.getRange(2, 1, 1, cols);
  subRange.merge();
  subRange.setValue(subtitle);
  subRange.setBackground(BLACK).setFontColor(MUTED).setFontStyle("italic").setFontSize(10)
    .setFontFamily(FONT).setVerticalAlignment("middle");
  sheet.setRowHeight(2, 18);
}

/** A numeric column must arrive as a NUMBER or Excel-style totals silently stop working. */
function coerce(label, raw) {
  if (NUMERIC[label] && raw !== "" && raw !== null) {
    var parsed = Number(raw);
    if (!isNaN(parsed)) return parsed;
  }
  return raw;
}

function applyColumnFormats(sheet, header, startRow, numRows) {
  if (numRows <= 0) return;
  for (var i = 0; i < header.length; i++) {
    var fmt = NUMERIC[header[i]];
    if (fmt) sheet.getRange(startRow, i + 1, numRows, 1).setNumberFormat(fmt).setHorizontalAlignment("right");
  }
}

/**
 * Widths are set ONCE, from the header, and never auto-resized on a refresh.
 *
 * autoResize on every pull is what made the Direct Orders sheet unreadable: columns visibly
 * jumping while the reader's eye was on them. The owner's rule is also that text must never wrap
 * or be truncated, so the widths here are generous rather than tight.
 */
function sizeColumns(sheet, header, cols) {
  for (var i = 0; i < cols; i++) {
    var label = String(header[i]);
    var width = 130;
    if (label.indexOf("link") >= 0 || label === "Request Preview") width = 150;
    else if (label.indexOf("Address") >= 0 || label.indexOf("notes") >= 0 || label.indexOf("Notes") >= 0) width = 320;
    else if (label.indexOf("name") >= 0 || label.indexOf("Name") >= 0 || label.indexOf("by") === label.length - 2) width = 220;
    else if (label.indexOf("at") === label.length - 2) width = 160;
    else if (label.length > 22) width = 200;
    sheet.setColumnWidth(i + 1, width);
  }
}

/**
 * Put the tabs in a stable order WITHOUT setActiveSheet.
 *
 * moveActiveSheet is the only reordering API, so the active sheet is saved and restored around it.
 * Skipping that is what once yanked the viewer off whatever tab they had open, every minute.
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
