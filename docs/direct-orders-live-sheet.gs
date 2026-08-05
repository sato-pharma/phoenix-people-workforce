/**
 * Phoenix Workforce — Direct Orders live Google Sheet
 * ==================================================================================
 * Keeps the owner's Google Sheet in step with the share-link feed, as a faithful
 * copy of the downloadable Direct Orders .xlsx: the same three tabs, the same 39
 * columns, the same Phoenix styling, the same totals.
 *
 * STRUCTURE ONCE, VALUES EVERY MINUTE
 *   The layout is only rebuilt when it is actually wrong -- first run, or the column
 *   set changed. Every other refresh writes VALUES ONLY. The first version rebuilt
 *   everything each minute, which made the sheet unusable: it cleared and redrew (a
 *   visible flicker), re-ran autoResize (columns resizing while you read), and
 *   re-ordered the tabs via setActiveSheet -- which yanked the viewer off whatever
 *   tab they had open, once a minute.
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
 *   The feed token is a bearer credential: anyone holding it can read every direct order
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
var FEED_BASE = "https://phoenix-hr.satopharma.com/api/share/direct-orders/";

/**
 * BOOTSTRAP ONLY — the token used until Phoenix hands over a rotated one.
 *
 * This file is committed to the repository, so anything written here is a permanent credential in
 * git history. That is why it is a bootstrap and not the real answer: the moment Phoenix rotates,
 * the live token lives in a Script Property (which is NOT committed anywhere) and this value is
 * revoked server-side, making the copy in git worthless.
 *
 * Rotation is automatic — see doPost's rotateToken branch. Nobody has to open this editor for it.
 */
var BOOTSTRAP_FEED_TOKEN = "pgn0W2b6jES7op9t7bChvrdzI95xoZbuygXb35Gu--w";

/** The token in force right now: a rotated one if Phoenix has sent it, else the bootstrap. */
function feedToken() {
  var stored = PropertiesService.getScriptProperties().getProperty("FEED_TOKEN");
  return stored || BOOTSTRAP_FEED_TOKEN;
}

/** Built per call, never cached — a rotation must take effect on the very next refresh. */
function feedUrl() {
  return FEED_BASE + feedToken() + "/feed?bundle=1";
}

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

/**
 * Push endpoint (spec D5e). Phoenix POSTs here the moment a direct order changes, so the sheet
 * updates immediately instead of waiting up to 60 seconds for the next timer tick.
 *
 * WHY THIS AND NOT THE SHEETS API
 * The original design used a Google service-account key. Google's `iam.disableServiceAccountKeyCreation`
 * org policy blocks creating one — correctly, because long-lived JSON keys leak. This script already
 * runs as the sheet's owner, so a Web App deployment needs no key, no GCP project, and no policy
 * exemption.
 *
 * SECURITY
 * The deployment must be reachable by "Anyone" because Phoenix calls it unauthenticated — so the
 * URL alone must not be enough. WEBHOOK_SECRET is what actually authorises; set it to the same
 * value as SHEET_REFRESH_WEBHOOK_SECRET in Railway. A leaked URL without the secret can do nothing.
 *
 * Store the secret in Script Properties, not here:
 *   Apps Script editor -> Project Settings -> Script Properties -> Add
 *   Property: WEBHOOK_SECRET     Value: <the same long random string you put in Railway>
 */
function doPost(e) {
  var expected = resolveWebhookSecret();
  if (!expected) {
    // Refuse rather than accept everything. An unset secret must fail CLOSED — the opposite would
    // mean a fresh deployment silently accepts any caller on the internet.
    return ContentService.createTextOutput("not configured").setMimeType(ContentService.MimeType.TEXT);
  }

  var payload = {};
  try {
    payload = JSON.parse(e && e.postData ? e.postData.contents : "{}") || {};
  } catch (err) {
    payload = {};
  }
  // Deliberately vague: a caller learns whether they are authorised, never why not.
  if (String(payload.secret || "") !== expected) {
    return ContentService.createTextOutput("denied").setMimeType(ContentService.MimeType.TEXT);
  }

  // ── Token rotation ───────────────────────────────────────────────────────────────────────
  // Phoenix mints a new share token and hands it over HERE, authorised by the token currently in
  // force. Storing it in a Script Property — which is not committed anywhere — is what lets the
  // bootstrap token in this file be revoked and become worthless, without anyone opening the editor.
  //
  // Phoenix only revokes the old token AFTER confirming this returned "rotated", so a rotation that
  // fails to arrive leaves the sheet working on the old one rather than dead.
  var rotate = String(payload.rotateToken || "").trim();
  if (rotate) {
    if (!/^[A-Za-z0-9_-]{20,}$/.test(rotate)) {
      // Refuse anything that is not a plausible token rather than storing rubbish that would
      // silently break every refresh from here on.
      return ContentService.createTextOutput("bad token").setMimeType(ContentService.MimeType.TEXT);
    }
    var props = PropertiesService.getScriptProperties();
    // PIN THE WEBHOOK SECRET FIRST, and the order is not incidental.
    //
    // With no explicit WEBHOOK_SECRET the secret defaults to the feed token. Rotating FEED_TOKEN
    // would therefore move the secret too — while Phoenix's SHEET_REFRESH_WEBHOOK_SECRET still held
    // the old value, because a running app cannot rewrite its own environment. Every push after the
    // first rotation would have been denied, silently, with the sheet quietly falling back to its
    // 60-second timer and nobody the wiser.
    //
    // Pinning the CURRENT secret separates the two concerns for good: the feed token rotates freely
    // as the data credential, while the webhook secret stays put as the trigger password. The pinned
    // value is only ever a permission to say "refresh yourself" — it reads nothing.
    if (!props.getProperty("WEBHOOK_SECRET")) props.setProperty("WEBHOOK_SECRET", expected);
    props.setProperty("FEED_TOKEN", rotate);
    refreshDirectOrders();
    return ContentService.createTextOutput("rotated").setMimeType(ContentService.MimeType.TEXT);
  }

  refreshDirectOrders();
  return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
}

/**
 * What value authorises a push?
 *
 * A Script Property named WEBHOOK_SECRET wins if one is set. If not, the feed token this script
 * already holds is used instead — which means the push endpoint works the moment the script is
 * pasted, with nothing else to configure.
 *
 * That fallback grants NOTHING extra, and the reason is worth stating: the only thing doPost can do
 * is make this sheet re-read the feed. Anyone holding the feed token can already read that feed
 * directly, in full, whenever they like. Authorising a refresh with the same token therefore adds
 * no capability an attacker did not already have — while an unset secret with no fallback would
 * either lock the owner out or, worse, tempt someone to accept unauthenticated calls.
 *
 * Set WEBHOOK_SECRET explicitly if you ever want the two separated — for instance after rotating
 * the feed token.
 */
function resolveWebhookSecret() {
  var explicit = PropertiesService.getScriptProperties().getProperty("WEBHOOK_SECRET");
  if (explicit) return explicit;
  return feedToken();
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
    response = UrlFetchApp.fetch(feedUrl(), { muteHttpExceptions: true });
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

  // `created` collects any tab this run had to make. Tab ORDER is only touched when that list is
  // non-empty, because ordering requires setActiveSheet — which yanks the viewer off whatever tab
  // they are reading. Doing that once a minute made the sheet unusable.
  var created = [];
  buildOrdersSheet(ss, bundle.orders, stamp, created);
  buildByStatusSheet(ss, bundle.byStatus, created);
  buildCoverSheet(ss, bundle.summary, bundle.orders.length - 1, stamp, created);

  // Last, and inside its own try: the backup is a safety net, so a fault in it must never take
  // down the refresh that feeds the live tabs.
  try {
    appendBackup(ss, bundle.orders, stamp, created);
  } catch (err) {
    console.error("Backup append failed (live tabs are unaffected): " + err);
  }

  if (created.length) orderTabs(ss, ["Cover", "Direct Orders", "By Status", "Backup"]);
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
function buildOrdersSheet(ss, grid, stamp, created) {
  var header = grid[0];
  var body = grid.slice(1);
  var cols = header.length;

  var sheet = getOrCreateSheet(ss, "Direct Orders", created);

  // Rebuild the STRUCTURE only when it is actually wrong — first run, or the column set changed
  // (e.g. the 25-to-39 upgrade). On every other refresh only the values are rewritten, which is
  // what stops the sheet flickering, jumping and resizing itself once a minute.
  var rebuild = !headerMatches(sheet, header);
  var previousLastRow = sheet.getLastRow();

  if (rebuild) {
    resetSheet(sheet);
    bandTitle(sheet, cols, "Direct Orders", null);
    sheet.getRange(2, 1, 1, cols)
      .setValues([header])
      .setBackground(BLACK)
      .setFontColor(WHITE)
      .setFontWeight("bold")
      .setFontFamily(FONT)
      .setFontSize(10.5)
      .setVerticalAlignment("middle")
      .setWrap(true);
    sheet.setRowHeight(2, 34);
  }

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

  // Orders can disappear (approved, expired, reversed). Clear whatever the previous run left below
  // the new total row, or a deleted order lingers on screen forever as a ghost.
  if (previousLastRow > totalRow) {
    sheet.getRange(totalRow + 1, 1, previousLastRow - totalRow, Math.max(cols, sheet.getLastColumn())).clear();
  }

  // Structure-only work. Re-running any of this every minute is what made the sheet unusable:
  // autoResize changes every column width while you are reading, and re-creating the filter throws
  // away whatever filter YOU had applied.
  var rowCountChanged = previousLastRow !== totalRow;
  if (rebuild) {
    // Rows 1-2 (brand band + header) stay pinned; row 3 is the first scrolling order.
    //
    // No setFrozenColumns here. The row-1 band is merged across all 39 columns, and Google refuses
    // to freeze a column boundary that would cut a merged cell in half ("you can't freeze columns
    // which contain only part of a merged cell"). Un-merging to allow it is worse: overflow text
    // does not render across a frozen-pane edge, so the title would appear truncated the moment you
    // scrolled right — and truncated text is exactly what this report must never show.
    sheet.setFrozenRows(2);
    sizeColumns(sheet, header, cols);
  }
  if (rebuild || rowCountChanged) {
    if (sheet.getFilter()) sheet.getFilter().remove();
    // Header + body only. Including the TOTAL row would let a filter hide or re-sort the grand
    // total, which is how a report ends up showing a number that belongs to nothing on screen.
    if (body.length) sheet.getRange(2, 1, body.length + 1, cols).createFilter();
  }

  // Refresh stamp, parked clear of the table. Value-only, so it never disturbs the layout.
  var stampCell = sheet.getRange(1, cols + 2);
  stampCell.setValue("Updated " + stamp + " (Cairo)");
  if (rebuild) {
    stampCell.setFontColor(MUTED).setFontFamily(FONT).setFontSize(9).setFontStyle("italic");
  }
}

/** The By Status breakdown, mirroring the .xlsx's second sheet. */
function buildByStatusSheet(ss, grid, created) {
  if (!grid.length) return;
  var sheet = getOrCreateSheet(ss, "By Status", created);

  var header = grid[0];
  var body = grid.slice(1);
  var cols = header.length;

  // Same rule as the orders tab: structure once, values every time. A status can appear or vanish
  // as orders move, so the row count changes -- but the LAYOUT does not.
  var rebuild = !headerMatches(sheet, header);
  var previousLastRow = sheet.getLastRow();

  if (rebuild) {
    resetSheet(sheet);
    bandTitle(sheet, cols, "Direct orders by status", null);
    sheet.getRange(2, 1, 1, cols)
      .setValues([header])
      .setBackground(BLACK)
      .setFontColor(WHITE)
      .setFontWeight("bold")
      .setFontFamily(FONT)
      .setFontSize(10.5);
  }

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

  // A status that no longer occurs must not linger below the new total row.
  if (previousLastRow > totalRow) {
    sheet.getRange(totalRow + 1, 1, previousLastRow - totalRow, 3).clear();
  }

  if (rebuild) {
    sheet.setFrozenRows(2);
    sheet.setColumnWidth(1, 200);
    sheet.setColumnWidth(2, 120);
    sheet.setColumnWidth(3, 180);
  }
}

/** The Cover / provenance sheet, matching the .xlsx's first sheet. */
function buildCoverSheet(ss, summary, rowCount, stamp, created) {
  var sheet = getOrCreateSheet(ss, "Cover", created);
  // The cover is small and entirely derived, so a full redraw here is cheap and invisible — but
  // the column widths and brand band are only set when the sheet is actually being built.
  var rebuild = sheet.getLastRow() < 5;
  if (rebuild) {
    resetSheet(sheet);
    sheet.setColumnWidth(1, 260);
    sheet.setColumnWidth(2, 460);
  }

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

// ── Backup ──────────────────────────────────────────────────────────────────────

/**
 * An append-only archive of every order state this sheet has ever seen.
 *
 * The three live tabs are a MIRROR: they show what the feed says right now, so anything the feed
 * stops sending disappears from them. That is correct for a live report and useless as a record.
 * This tab is the opposite — nothing is ever cleared, so it survives:
 *
 *   · an order deleted, reversed or expired upstream       (its last known state stays here)
 *   · someone editing or deleting rows by hand
 *   · the share link being revoked or the feed going down  (the last good copy stays here)
 *   · a bad refresh
 *
 * Rows are appended ONLY when an order is new or its values actually changed, so a sheet that sits
 * idle for a week adds nothing. Comparison is by a cheap hash held in its own column, so the cost
 * does not grow with the archive: only two columns are read back each cycle, never all 39.
 */
function appendBackup(ss, grid, stamp, created) {
  var header = grid[0];
  var body = grid.slice(1);
  if (!body.length) return;

  var sheet = getOrCreateSheet(ss, "Backup", created);
  var META = ["Captured (Cairo)", "Change", "Request ID", "Row hash"];

  // Build the header once, on first use.
  if (sheet.getLastRow() < 1) {
    var head = META.concat(header);
    sheet.getRange(1, 1, 1, head.length)
      .setValues([head])
      .setBackground(BLACK)
      .setFontColor(WHITE)
      .setFontWeight("bold")
      .setFontFamily(FONT)
      .setFontSize(10.5);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 150);
    sheet.setColumnWidth(2, 90);
    sheet.setColumnWidth(3, 300);
    sheet.setColumnWidth(4, 110);
  }

  // Read back only Request ID + hash. Keeping this to two columns is what stops the archive
  // slowing the 60-second cycle as it grows.
  var lastRow = sheet.getLastRow();
  var seen = {};
  if (lastRow > 1) {
    var known = sheet.getRange(2, 3, lastRow - 1, 2).getValues();
    for (var k = 0; k < known.length; k++) {
      // Later rows overwrite earlier ones, so this ends up holding the MOST RECENT hash per order.
      if (known[k][0]) seen[String(known[k][0])] = String(known[k][1]);
    }
  }

  var idIndex = findCol(header, ["Request ID"]);
  var pending = [];
  for (var r = 0; r < body.length; r++) {
    var row = body[r];
    var id = idIndex === -1 ? "" : String(row[idIndex] || "");
    if (!id) continue;
    var hash = hashRow(row);
    var previous = seen[id];
    if (previous === hash) continue;                      // unchanged — nothing to record
    pending.push([stamp, previous === undefined ? "new" : "updated", id, hash].concat(row));
  }
  if (!pending.length) return;

  var width = META.length + header.length;
  // Normalise width: a short row would otherwise shift every later column.
  for (var p = 0; p < pending.length; p++) {
    while (pending[p].length < width) pending[p].push("");
    pending[p] = pending[p].slice(0, width);
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, pending.length, width)
    .setValues(pending)
    .setFontFamily(FONT)
    .setFontSize(10)
    .setFontColor(SLATE);

  console.log("Backup: appended " + pending.length + " row(s).");
}

/**
 * A short, stable fingerprint of a row.
 *
 * Only used to answer "did this change since last time", so collision resistance is irrelevant and
 * a fast checksum beats a cryptographic digest. The unit separator cannot appear in the feed's CSV
 * values, so adjacent fields can never blur into one another and hide a change.
 */
function hashRow(row) {
  var text = row.join("\u001f");
  var h = 0;
  for (var i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return String(h);
}

// ── Shared helpers ──────────────────────────────────────────────────────────────

/**
 * Get a sheet, creating it only if absent. Records creations in `created` so the caller knows a
 * structural build is needed — and so tab ordering runs once rather than every minute.
 *
 * Deliberately does NOT clear. Clearing on every refresh is what made the sheet flicker: the whole
 * table vanished and reappeared once a minute, which reads as data loss even though it isn't.
 */
function getOrCreateSheet(ss, name, created) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    created.push(name);
  }
  return sheet;
}

/** Wipe a sheet to bare metal. Only called when the layout genuinely has to change. */
function resetSheet(sheet) {
  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.clear();
  sheet.clearNotes();
  sheet.setHiddenGridlines(true);
  return sheet;
}

/**
 * Does this sheet already carry exactly this header on row 2?
 *
 * The decision that keeps the sheet still. Same header means the structure is right and only the
 * VALUES need refreshing — no clear, no restyle, no column resize, no filter churn. It also handles
 * the 25-to-39-column upgrade automatically: the header changes, so a rebuild happens once, then
 * never again.
 */
function headerMatches(sheet, header) {
  if (sheet.getLastRow() < 2) return false;
  var width = sheet.getLastColumn();
  if (width !== header.length) return false;
  var current = sheet.getRange(2, 1, 1, width).getValues()[0];
  for (var i = 0; i < header.length; i++) {
    if (String(current[i]) !== String(header[i])) return false;
  }
  return true;
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
