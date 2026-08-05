/**
 * Phoenix Workforce — Direct Orders live Google Sheet
 * ==================================================================================
 * Rebuilds the owner's Google Sheet every minute from the share-link feed, as a
 * faithful copy of the downloadable Direct Orders .xlsx: the same three tabs, the
 * same 39 columns, the same Phoenix styling, the same totals.
 *
 * WHY A SCRIPT AND NOT =IMPORTDATA
 *   IMPORTDATA refreshes on Google's own schedule — roughly hourly, not configurable
 *   — and can only ever produce one flat table. This runs on a 1-minute trigger and
 *   builds all three sheets. The feed itself answers in ~1.5s with no caching, so the
 *   sheet is effectively live.
 *
 * SETUP (once)
 *   1. Extensions -> Apps Script
 *   2. Delete the placeholder code, paste this file, Save
 *   3. Choose `installTrigger` in the function dropdown, click Run
 *   4. Authorise when Google asks (it is asking about YOUR OWN script)
 *   Refreshes every minute from then on, including while the sheet is closed.
 *
 * SECURITY
 *   FEED_URL contains a bearer token: anyone holding it can read every direct order
 *   this link's scope covers. Keep the SHEET private and share the sheet, never the
 *   URL. The token can be revoked server-side at any time, which instantly kills this
 *   script's access.
 *
 * FAIL-SAFE
 *   Nothing is cleared until a good response has been fetched AND parsed. A network
 *   blip, an expired token or a revoked link leaves the last good data on screen
 *   rather than blanking the report — a sheet that silently empties itself reads as
 *   "all the orders are gone", which is worse than stale data.
 */

// ── Configuration ────────────────────────────────────────────────────────────────
var FEED_URL =
  "https://phoenix-hr.satopharma.com/api/share/direct-orders/" +
  "pgn0W2b6jES7op9t7bChvrdzI95xoZbuygXb35Gu--w" +
  "/feed?bundle=1";

var TZ = "Africa/Cairo";

// ── Phoenix brand palette (exactly the .xlsx export's colours) ───────────────────
var BLACK = "#000000";
var ORANGE = "#F97316";
var AMBER = "#FDE7C7";
var AMBER_TEXT = "#B45309";
var WHITE = "#FFFFFF";
var SLATE = "#334155";
var MUTED = "#94A3B8";
var ZEBRA = "#F8FAFC";
var GRID = "#F8B56B";
var FONT = "Calibri";

var UNITS_FMT = "#,##0";
var VALUE_FMT = "#,##0.00";

/** Columns holding numbers — they must arrive as numbers, not text, or totals break. */
var NUMERIC = {
  "Qty (units)": UNITS_FMT,
  "Bonus (units)": UNITS_FMT,
  "Pharmacy price": VALUE_FMT,
  "Sales value (EGP)": VALUE_FMT,
  "Discount %": null,
  "Public price": VALUE_FMT,
  "Paid (EGP)": VALUE_FMT,
  "Remaining (EGP)": VALUE_FMT
};

/** The two columns that get a grand total on the Direct Orders tab. */
var TOTALLED = ["Qty (units)", "Sales value (EGP)"];

// ── Entry points ────────────────────────────────────────────────────────────────

/** Run once, by hand, to install the 1-minute trigger. Safe to re-run. */
function installTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) ScriptApp.deleteTrigger(existing[i]);
  ScriptApp.newTrigger("refreshDirectOrders").timeBased().everyMinutes(1).create();
  refreshDirectOrders();
}

/** Adds a Phoenix menu so a refresh can also be forced by hand. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Phoenix")
    .addItem("Refresh now", "refreshDirectOrders")
    .addToUi();
}

/** The trigger target. Fetch, parse, then rebuild all three tabs. */
function refreshDirectOrders() {
  var response;
  try {
    response = UrlFetchApp.fetch(FEED_URL, { muteHttpExceptions: true });
  } catch (err) {
    console.error("Feed unreachable: " + err);
    return; // keep whatever is on screen
  }
  if (response.getResponseCode() !== 200) {
    console.error("Feed returned HTTP " + response.getResponseCode());
    return;
  }

  var bundle = parseBundle(response.getContentText("UTF-8"));
  // Refuse to redraw on a payload that lost its shape — better stale than wrong.
  if (!bundle.orders.length || bundle.orders[0].length < 2) {
    console.error("Feed parsed but carried no order table; keeping existing data.");
    return;
  }

  // The server may be older than this script and send only the order table. Everything the other
  // two tabs need is derivable from those rows, so compute it here rather than refusing to draw.
  // This is what keeps the sheet working across a deploy in either direction.
  if (!bundle.summary.length || !bundle.byStatus.length) {
    var derived = deriveSections(bundle.orders);
    if (!bundle.summary.length) bundle.summary = derived.summary;
    if (!bundle.byStatus.length) bundle.byStatus = derived.byStatus;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var stamp = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");

  buildOrdersSheet(ss, bundle.orders, stamp);
  buildByStatusSheet(ss, bundle.byStatus);
  buildCoverSheet(ss, bundle.summary, bundle.orders.length - 1, stamp);

  orderTabs(ss, ["Cover", "Direct Orders", "By Status"]);
}

// ── Feed parsing ────────────────────────────────────────────────────────────────

/**
 * Split the one payload into its three sections.
 *
 * The feed marks them with `#SUMMARY` / `#BYSTATUS` / `#ORDERS` lines and returns
 * them together, so all three tabs are guaranteed to describe the same instant. A
 * cover reading "14 orders" above a table listing 15 is exactly the sort of quiet
 * inconsistency that makes people stop trusting a report.
 */
function parseBundle(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip the Excel BOM
  var rows = Utilities.parseCsv(text);
  var out = { summary: [], byStatus: [], orders: [] };
  var current = null;
  for (var i = 0; i < rows.length; i++) {
    var first = rows[i].length ? String(rows[i][0]) : "";
    if (first === "#SUMMARY") { current = out.summary; continue; }
    if (first === "#BYSTATUS") { current = out.byStatus; continue; }
    if (first === "#ORDERS") { current = out.orders; continue; }
    if (current && rows[i].join("") !== "") current.push(rows[i]);
  }

  // No markers at all: an older server that only knows how to send the flat order table. Treat the
  // whole payload as that table rather than refusing to draw — the script must not be hostage to a
  // deploy it cannot see.
  if (!out.orders.length) {
    for (var j = 0; j < rows.length; j++) {
      if (rows[j].join("") !== "") out.orders.push(rows[j]);
    }
  }
  return out;
}

/** Find a column by any of the headings the feed has used, old or new. */
function findCol(header, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var idx = header.indexOf(candidates[i]);
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Compute the cover figures and the by-status breakdown from the order rows themselves.
 *
 * Used whenever the server did not send those sections. Everything they contain is already implied
 * by the table, so deriving them locally costs nothing and removes the script's dependency on a
 * particular server version.
 */
function deriveSections(orders) {
  var header = orders[0];
  var body = orders.slice(1);
  var cStatus = findCol(header, ["Status"]);
  var cValue = findCol(header, ["Sales value (EGP)"]);
  var cQty = findCol(header, ["Qty (units)", "Quantity"]);

  var num = function (v) { return Number(String(v === undefined ? "" : v).replace(/,/g, "")) || 0; };
  var total = 0, approved = 0, units = 0, map = {};

  for (var i = 0; i < body.length; i++) {
    var status = cStatus === -1 ? "" : String(body[i][cStatus]);
    var value = cValue === -1 ? 0 : num(body[i][cValue]);
    total += value;
    units += cQty === -1 ? 0 : num(body[i][cQty]);
    if (status === "approved") approved += value;
    if (!map[status]) map[status] = { count: 0, value: 0 };
    map[status].count += 1;
    map[status].value += value;
  }

  var statuses = Object.keys(map).sort();
  var byStatus = [["Status", "Requests", "Sales value (EGP)"]];
  for (var s = 0; s < statuses.length; s++) {
    byStatus.push([statuses[s], map[statuses[s]].count, map[statuses[s]].value.toFixed(2)]);
  }

  return {
    summary: [
      ["Metric", "Value"],
      ["Rows", String(body.length)],
      ["Total sales value (EGP)", total.toFixed(2)],
      ["Approved sales value (EGP)", approved.toFixed(2)],
      ["Total units", String(units)]
    ],
    byStatus: byStatus
  };
}

// ── Sheet builders ──────────────────────────────────────────────────────────────

/** The main table: 39 columns, frozen header, filter, banded rows, grand total. */
function buildOrdersSheet(ss, grid, stamp) {
  var header = grid[0];
  var body = grid.slice(1);
  var cols = header.length;

  var sheet = resetSheet(ss, "Direct Orders");
  bandTitle(sheet, cols, "Direct Orders — " + body.length + " row(s)", null);

  // Header row (row 2).
  var headerRange = sheet.getRange(2, 1, 1, cols);
  headerRange
    .setValues([header])
    .setBackground(BLACK)
    .setFontColor(WHITE)
    .setFontWeight("bold")
    .setFontFamily(FONT)
    .setFontSize(10.5)
    .setVerticalAlignment("middle")
    .setWrap(true);
  sheet.setRowHeight(2, 34);

  // Body (row 3 onward). Numbers are coerced so totals and formats actually apply.
  if (body.length) {
    var values = [];
    var backgrounds = [];
    for (var r = 0; r < body.length; r++) {
      var row = [];
      var band = [];
      for (var c = 0; c < cols; c++) {
        var raw = c < body[r].length ? body[r][c] : "";
        row.push(coerce(header[c], raw));
        band.push(r % 2 === 1 ? ZEBRA : WHITE);
      }
      values.push(row);
      backgrounds.push(band);
    }
    var bodyRange = sheet.getRange(3, 1, body.length, cols);
    bodyRange
      .setValues(values)
      .setBackgrounds(backgrounds)
      .setFontColor(SLATE)
      .setFontFamily(FONT)
      .setFontSize(10.5)
      .setVerticalAlignment("middle")
      .setWrap(false); // owner's rule: never wrap, never truncate with an ellipsis
    applyColumnFormats(sheet, header, 3, body.length);
  }

  // Grand total row, in the .xlsx's amber. Written as live =SUM formulas rather than
  // pre-computed numbers so the figure stays correct if anyone edits a cell by hand.
  var totalRow = 3 + body.length;
  var totals = [];
  for (var t = 0; t < cols; t++) {
    if (header[t] === "Status") {
      totals.push("TOTAL");
    } else if (TOTALLED.indexOf(header[t]) !== -1 && body.length) {
      var letter = columnLetter(t + 1);
      totals.push("=SUM(" + letter + "3:" + letter + (totalRow - 1) + ")");
    } else {
      totals.push("");
    }
  }
  var totalRange = sheet.getRange(totalRow, 1, 1, cols);
  totalRange
    .setValues([totals])
    .setBackground(AMBER)
    .setFontColor(BLACK)
    .setFontWeight("bold")
    .setFontFamily(FONT)
    .setFontSize(10.5);
  applyColumnFormats(sheet, header, totalRow, 1);

  // Alignment: numeric columns right, everything else left.
  for (var a = 0; a < cols; a++) {
    var align = NUMERIC.hasOwnProperty(header[a]) ? "right" : "left";
    sheet.getRange(2, a + 1, totalRow - 1, 1).setHorizontalAlignment(align);
  }

  sheet.getRange(2, 1, totalRow - 1, cols).setBorder(true, true, true, true, true, true, GRID, SpreadsheetApp.BorderStyle.SOLID);
  // Rows 1-2 (brand band + header) stay pinned; row 3 is the first scrolling order.
  //
  // No setFrozenColumns here. The row-1 band is merged across all 39 columns, and Google refuses
  // to freeze a column boundary that would cut a merged cell in half ("you can't freeze columns
  // which contain only part of a merged cell"). Un-merging to allow it is worse: overflow text
  // does not render across a frozen-pane edge, so the title would appear truncated the moment you
  // scrolled right — and truncated text is exactly what this report must never show.
  sheet.setFrozenRows(2);
  if (sheet.getFilter()) sheet.getFilter().remove();
  // Header + body only. Including the TOTAL row would let a filter hide or re-sort the grand
  // total, which is how a report ends up showing a number that belongs to nothing on screen.
  if (body.length) sheet.getRange(2, 1, body.length + 1, cols).createFilter();
  sizeColumns(sheet, header, cols);

  // Refresh stamp, parked clear of the table.
  sheet.getRange(1, cols + 2)
    .setValue("Updated " + stamp + " (Cairo)")
    .setFontColor(MUTED)
    .setFontFamily(FONT)
    .setFontSize(9)
    .setFontStyle("italic");
}

/** The By Status breakdown, mirroring the .xlsx's second sheet. */
function buildByStatusSheet(ss, grid) {
  var sheet = resetSheet(ss, "By Status");
  if (!grid.length) return;

  var header = grid[0];
  var body = grid.slice(1);
  var cols = header.length;

  bandTitle(sheet, cols, "Direct orders by status", null);

  sheet.getRange(2, 1, 1, cols)
    .setValues([header])
    .setBackground(BLACK)
    .setFontColor(WHITE)
    .setFontWeight("bold")
    .setFontFamily(FONT)
    .setFontSize(10.5);

  if (body.length) {
    var values = [];
    var backgrounds = [];
    for (var r = 0; r < body.length; r++) {
      values.push([body[r][0], Number(body[r][1]) || 0, Number(body[r][2]) || 0]);
      backgrounds.push([
        r % 2 === 1 ? ZEBRA : WHITE,
        r % 2 === 1 ? ZEBRA : WHITE,
        r % 2 === 1 ? ZEBRA : WHITE
      ]);
    }
    sheet.getRange(3, 1, body.length, 3)
      .setValues(values)
      .setBackgrounds(backgrounds)
      .setFontColor(SLATE)
      .setFontFamily(FONT)
      .setFontSize(10.5);
    sheet.getRange(3, 2, body.length, 1).setNumberFormat(UNITS_FMT);
    sheet.getRange(3, 3, body.length, 1).setNumberFormat(VALUE_FMT);
  }

  var totalRow = 3 + body.length;
  sheet.getRange(totalRow, 1, 1, 3)
    .setValues([[
      "TOTAL",
      body.length ? "=SUM(B3:B" + (totalRow - 1) + ")" : 0,
      body.length ? "=SUM(C3:C" + (totalRow - 1) + ")" : 0
    ]])
    .setBackground(AMBER)
    .setFontColor(BLACK)
    .setFontWeight("bold")
    .setFontFamily(FONT)
    .setFontSize(10.5);
  sheet.getRange(totalRow, 2).setNumberFormat(UNITS_FMT);
  sheet.getRange(totalRow, 3).setNumberFormat(VALUE_FMT);

  sheet.getRange(2, 2, totalRow - 1, 2).setHorizontalAlignment("right");
  sheet.getRange(2, 1, totalRow - 1, 3).setBorder(true, true, true, true, true, true, GRID, SpreadsheetApp.BorderStyle.SOLID);
  sheet.setFrozenRows(2);
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 120);
  sheet.setColumnWidth(3, 180);
}

/** The Cover / provenance sheet, matching the .xlsx's first sheet. */
function buildCoverSheet(ss, summary, rowCount, stamp) {
  var sheet = resetSheet(ss, "Cover");
  sheet.setColumnWidth(1, 260);
  sheet.setColumnWidth(2, 460);

  bandTitle(
    sheet,
    2,
    "Phoenix Workforce — Direct Orders Report",
    "Governed direct (company) orders — requests, approvals, and money"
  );

  sheet.getRange(3, 1, 1, 2).merge()
    .setValue(
      "CONFIDENTIAL — internal sales/finance data. Bonus deals are valued at approved qty x " +
      "pharmacy price (bonus units excluded); discount deals at qty x public price x (1 - discount%)."
    )
    .setBackground(AMBER)
    .setFontColor(AMBER_TEXT)
    .setFontWeight("bold")
    .setFontFamily(FONT)
    .setFontSize(10.5)
    .setVerticalAlignment("middle")
    .setWrap(true);
  sheet.setRowHeight(3, 44);

  sheet.getRange(5, 1)
    .setValue("Report provenance")
    .setFontColor(ORANGE)
    .setFontWeight("bold")
    .setFontFamily(FONT)
    .setFontSize(12);

  // The feed's own figures first, then the two this side knows about.
  var rows = [];
  for (var i = 1; i < summary.length; i++) {           // row 0 is the section header
    if (summary[i].length >= 2) rows.push([summary[i][0], summary[i][1]]);
  }
  rows.push(["Rows rendered here", String(rowCount)]);
  rows.push(["Last refreshed (Cairo)", stamp]);
  rows.push(["Refresh interval", "Every 1 minute, automatic"]);

  if (rows.length) {
    var start = 6;
    sheet.getRange(start, 1, rows.length, 2)
      .setValues(rows)
      .setFontColor(SLATE)
      .setFontFamily(FONT)
      .setFontSize(10.5)
      .setVerticalAlignment("top");
    sheet.getRange(start, 1, rows.length, 1).setFontWeight("bold");
    sheet.getRange(start, 2, rows.length, 1).setWrap(true);
    // Money reads as money, not as a long bare number.
    for (var m = 0; m < rows.length; m++) {
      if (String(rows[m][0]).indexOf("(EGP)") !== -1) {
        sheet.getRange(start + m, 2).setNumberFormat(VALUE_FMT).setValue(Number(rows[m][1]) || 0);
      }
    }
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────────

/** Get or create a sheet, wiped of both values AND formatting for a clean rebuild. */
function resetSheet(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.clear();
  sheet.clearNotes();
  sheet.setHiddenGridlines(true);
  return sheet;
}

/** The Phoenix two-row brand band: black bar, orange title, muted subtitle. */
function bandTitle(sheet, cols, title, subtitle) {
  sheet.getRange(1, 1, 1, cols).merge()
    .setValue(title)
    .setBackground(BLACK)
    .setFontColor(ORANGE)
    .setFontWeight("bold")
    .setFontFamily(FONT)
    .setFontSize(subtitle ? 16 : 12)
    .setVerticalAlignment("middle");
  sheet.setRowHeight(1, subtitle ? 44 : 28);

  if (subtitle) {
    sheet.getRange(2, 1, 1, cols).merge()
      .setValue(subtitle)
      .setBackground(BLACK)
      .setFontColor(MUTED)
      .setFontStyle("italic")
      .setFontFamily(FONT)
      .setFontSize(10.5)
      .setVerticalAlignment("middle");
    sheet.setRowHeight(2, 24);
  }
}

/** CSV gives strings; numeric columns must become real numbers. */
function coerce(label, raw) {
  if (!NUMERIC.hasOwnProperty(label)) return raw;
  if (raw === "" || raw === null || raw === undefined) return "";
  var n = Number(String(raw).replace(/,/g, ""));
  return isNaN(n) ? raw : n;
}

function applyColumnFormats(sheet, header, startRow, numRows) {
  for (var c = 0; c < header.length; c++) {
    var fmt = NUMERIC[header[c]];
    if (fmt) sheet.getRange(startRow, c + 1, numRows, 1).setNumberFormat(fmt);
  }
}

/**
 * Width by content, then clamped. Auto-resize alone lets one long pharmacy address
 * blow a column out to half the screen; a hard width alone truncates Arabic names.
 */
function sizeColumns(sheet, header, cols) {
  sheet.autoResizeColumns(1, cols);
  for (var c = 1; c <= cols; c++) {
    var w = sheet.getColumnWidth(c);
    if (w < 90) sheet.setColumnWidth(c, 90);
    if (w > 320) sheet.setColumnWidth(c, 320);
  }
}

/** 1 -> A, 27 -> AA. The order table runs past Z. */
function columnLetter(index) {
  var s = "";
  while (index > 0) {
    var m = (index - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    index = (index - m - 1) / 26;
  }
  return s;
}

/** Put the tabs in the .xlsx's order: Cover, Direct Orders, By Status. */
function orderTabs(ss, names) {
  for (var i = 0; i < names.length; i++) {
    var sheet = ss.getSheetByName(names[i]);
    if (!sheet) continue;
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(i + 1);
  }
  var first = ss.getSheetByName(names[0]);
  if (first) ss.setActiveSheet(first);
}
