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
 *   Comparison — the same live data as SHAPES: month against month in calendar order, line against
 *               line, region against region, what each line promised against what it was required
 *               to return, and where the money is sitting. Every chart is bound to the table beside
 *               it, so the two cannot disagree and both follow a filter on Requests together.
 *   Key Data  — the columns a decision actually needs, a projection of the same Requests rows.
 *   Requests / Products / Approval trail / Pharmacies — banded tables, frozen header and first
 *               column, a filter, a sticky TOTAL bar, and colour-coded status columns.
 *   Cover     — provenance.
 *
 * WHY A SCRIPT AND NOT =IMPORTDATA
 *   IMPORTDATA refreshes on Google's own schedule — roughly hourly, not configurable — and can
 *   only ever produce one flat table. This runs on a 1-minute trigger, builds eight tabs, and renders
 *   hyperlinks. Phoenix also PUSHES to doPost() the moment a request changes, so in practice the
 *   sheet is current within seconds. Overnight (23:00–08:00 Cairo) the timer fetches once an hour
 *   instead — see NIGHT PACING below — while a push still lands at once.
 *
 * SETUP (once)
 *   1. Extensions -> Apps Script
 *   2. Delete the placeholder code, paste this file, Save
 *   3. Project Settings -> Script Properties -> add FEED_TOKEN with the token Phoenix minted.
 *      The token is NOT written in this file — see the note above feedToken().
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
 *   The feed token is a bearer credential: anyone holding it can read every marketing request this
 *   link's scope covers, and open the evidence photographs. Keep the SHEET private and share the
 *   SHEET, never the URL. The token can be revoked server-side at any time, which instantly kills
 *   this script's access and every file link inside the sheet with it.
 *
 *   Phoenix rotates it automatically — see doPost's rotateToken branch. The live value lives in a
 *   Script Property that is committed nowhere, so nothing in this file opens anything.
 *
 * FAIL-SAFE
 *   Nothing is cleared until a good response has been fetched AND parsed. A network blip, an
 *   expired token or a revoked link leaves the last good data on screen rather than blanking the
 *   report — a sheet that silently empties itself reads as "all the requests are gone", which is
 *   worse than stale data.
 *
 *   It no longer does that in SILENCE. Row 2 turns into a red STALE banner naming when the figures
 *   stopped moving and why the last attempt failed, and clears itself the moment the feed answers
 *   again. Stale data you can see is safe; stale data that looks live is what cost the Direct Orders
 *   sheet eighteen days.
 */

// ── Configuration ────────────────────────────────────────────────────────────────
var FEED_BASE = "https://phoenix-hr.satopharma.com/api/share/marketing-requests/";

/**
 * The feed token, read from a Script Property — deliberately NOT a slot in this file.
 *
 * A token committed here lives in git history for good. Even a revoked one still reads to the next
 * person as live, and it invites the next setup to paste a live one beside it. On 2026-08-05 this
 * table was found readable by `anon`, so the then-current token had to be rotated by hand; keeping
 * the value out of the file is half of making sure that is never needed again.
 *
 * Set it once per sheet: Project Settings -> Script Properties -> FEED_TOKEN.
 * After that Phoenix rotates it automatically — see doPost's rotateToken branch. Nobody has to
 * open this editor again.
 */
function feedToken() {
  return String(PropertiesService.getScriptProperties().getProperty("FEED_TOKEN") || "").trim();
}

/**
 * Built per call, never cached — a rotation must take effect on the very next refresh.
 *
 * Returns "" when no token is configured. The caller treats that exactly like an unreachable feed:
 * leave the sheet alone. Returning a URL with an empty token would fetch a 404 and look like a
 * revoked link, sending whoever debugs it to the wrong place entirely.
 */
function feedUrl() {
  var token = feedToken();
  return token ? FEED_BASE + token + "/feed?bundle=1" : "";
}

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
  "Key Data": ["Amount", "Estimated ROI", "Required ROI"],
  "Requests": ["Amount", "Estimated ROI", "Required ROI", "Actual sales value", "Coverage gap"],
  "Products": ["Forecast quantity", "Expected value"],
  "Approval trail": [],
  "Pharmacies": []
};

var KEY_TAB = "Key Data";

/**
 * The decision-grade columns, in reading order.
 *
 * Requests carries all 109 fields and stays that way — when a number is questioned, the answer has
 * to be somewhere. But 109 columns is not a thing anyone reads; it is a thing people search. This
 * tab is the version you actually look at: who asked, for whom, how much, what it must return,
 * whether it is on track, and where it is stuck. Everything else is one click away on Requests.
 *
 * It is a PROJECTION of the same feed rows, not a second query, so the two tabs cannot disagree.
 * A label that the feed ever stops sending is skipped rather than left as an empty column.
 */
var KEY_COLUMNS = [
  "Serial",
  "Month",
  "Week",
  "Line",
  "Type",
  "Account/Dr.Name",
  "Region",
  "Requester",
  "Amount",
  "Estimated ROI",
  "Required ROI",
  "ROI coverage",
  "ROI status",
  "Status",
  "Current step",
  "Money transfer Date",
  "Days to approve",
  "Evidence photo link",
  "Request Preview"
];

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
var AUDIT_TAB = "Audit Trail";

/**
 * Tabs this sheet shipped under an earlier, less formal name.
 *
 * The owner's rule (2026-08-05): every tab name reads as something that belongs in a board pack.
 * "God Mode" and "Backup" did not.
 *
 * Each entry RENAMES the existing tab rather than letting a new one appear beside it. Inserting a
 * fresh tab would strand the old one, frozen at whatever it last showed — and for the audit trail
 * that would also abandon the history, which is the only thing it exists to keep.
 */
var LEGACY_TAB_NAMES = [
  { from: "God Mode", to: EXEC_TAB },
  { from: "Backup", to: AUDIT_TAB }
];

var COMPARISON_TAB = "Comparison";

/**
 * The columns the Comparison tab groups by.
 *
 * Their DISTINCT COUNTS ride the layout signature, which is what lets every chart be sized to the
 * data instead of to a guess. A chart bound to a fixed 12-row window would show empty slots for the
 * months that have not happened yet; a chart bound to today's count alone would silently omit a
 * region that appears next week — and a decision chart that quietly drops a region is far worse
 * than an ugly one. Folding the counts into the signature gets both: exact sizing now, and a
 * rebuild the moment a new month, line, region or status shows up.
 */
var COMPARISON_DOMAINS = ["Month", "Line", "Region", "Status"];

/** Charts float to the right of their own table, starting at this column. */
var CHART_COL = 7;
var CHART_WIDTH = 540;
/** A block is never shorter than this, so a three-row breakdown still gets a readable chart. */
var MIN_BLOCK_ROWS = 14;
var ROW_PX = 21;

/**
 * The append-only change history. Ported from the Direct Orders sheet, which had it first.
 *
 * Deliberately LAST in the tab order and deliberately outside the layout signature: it is the one
 * tab a rebuild must never touch, because resetting it would throw away the history that is its
 * entire reason for existing.
 */


var TAB_ORDER = [EXEC_TAB, COMPARISON_TAB, KEY_TAB, "Requests", "Products", "Approval trail", "Pharmacies", "Cover", AUDIT_TAB];

// ── Night pacing ────────────────────────────────────────────────────────────────
//
// Phoenix pushes to doPost the moment a request changes, so the 1-minute timer is only the safety
// net for a push that never arrived. At night nobody reads this sheet and almost nothing changes,
// yet the timer went on fetching the whole feed sixty times an hour. Measured on the night of
// 30–31 October 2026, this sheet and its Direct Orders twin were about 2,100 of the ~9,000 requests
// an hour Phoenix sent its database between 23:00 and 08:00 Cairo — the largest share nobody needed.
//
// So between NIGHT_START_HOUR and NIGHT_END_HOUR (Cairo) a TIMER tick fetches only when an hour has
// passed since the last fetch. Everything else fetches at once, at any hour: a push, a token
// rotation (also a push), "Refresh now", installTrigger, rebuildEverything, and a run from the
// editor. The daytime timer is untouched. A failing feed still shows its STALE banner overnight —
// within the hour.
var NIGHT_START_HOUR = 23;
var NIGHT_END_HOUR = 8;
var NIGHT_FETCH_EVERY_MS = 60 * 60 * 1000;
var LAST_FETCH_KEY = "phoenixLastFeedFetchMs";

/**
 * True only for a time-driven tick, overnight, within an hour of the last fetch.
 *
 * Only a time-driven trigger hands the function an event carrying `triggerUid`. doPost, the menu
 * and the editor call it with nothing, and those must always fetch — a push is how a change reaches
 * the sheet at night, and the rotation proves the new token by the read it causes.
 */
function nightTimerTickSkips_(e) {
  if (!e || !e.triggerUid) return false;
  var hour = Number(Utilities.formatDate(new Date(), TZ, "H"));
  if (hour < NIGHT_START_HOUR && hour >= NIGHT_END_HOUR) return false;
  // An unset or unreadable stamp reads as "never fetched", so the doubt resolves toward fetching.
  var last = Number(PropertiesService.getScriptProperties().getProperty(LAST_FETCH_KEY) || 0);
  return Date.now() - last < NIGHT_FETCH_EVERY_MS;
}

/** Stamp every fetch, whatever started it, so a push at 02:10 also counts as that hour's look. */
function noteFeedFetch_() {
  try {
    PropertiesService.getScriptProperties().setProperty(LAST_FETCH_KEY, String(Date.now()));
  } catch (err) {
    console.error("Could not record the fetch time (the next night tick will simply fetch): " + err);
  }
}

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

  // ── Token rotation ───────────────────────────────────────────────────────────────────────
  // Phoenix mints a new share token and hands it over HERE, authorised by the webhook secret
  // currently in force. Storing it in a Script Property — committed nowhere — is what lets an
  // exposed token be replaced without anyone opening this editor.
  //
  // Phoenix only revokes the old token AFTER observing that this script has READ with the new one,
  // so a rotation that fails to arrive leaves the sheet working on the old token rather than dead.
  //
  // Note WEBHOOK_SECRET is never touched here, unlike the direct-orders script which has to pin it
  // first. That script falls back to using its feed token as the webhook secret, so rotating the
  // token would move the secret with it; this one has always required an explicit WEBHOOK_SECRET
  // (see the fail-closed check above), so "may trigger a refresh" and "may read the data" are
  // already separate. Only the feed token rotates.
  var payload = {};
  try {
    payload = JSON.parse(e && e.postData ? e.postData.contents : "{}");
  } catch (err) {
    payload = {};
  }
  var rotate = String(payload.rotateToken || "").trim();
  if (rotate) {
    if (!/^[A-Za-z0-9_-]{20,}$/.test(rotate)) {
      // Refuse anything that is not a plausible token rather than storing rubbish that would
      // silently break every refresh from here on.
      return ContentService.createTextOutput("bad token").setMimeType(ContentService.MimeType.TEXT);
    }
    PropertiesService.getScriptProperties().setProperty("FEED_TOKEN", rotate);
    // Read immediately: this fetch is what proves to Phoenix that the token was stored, because it
    // bumps the new link's access_count on Phoenix's own side of the wire. A reply cannot prove it
    // — Apps Script answers a POST with a 302 that the caller follows as a GET.
    refreshMarketingRequests();
    return ContentService.createTextOutput("rotated").setMimeType(ContentService.MimeType.TEXT);
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

// ── Staleness banner ──────────────────────────────────────────────────────────
//
// Every early return below is correct — the last good data must stay on screen, because a sheet
// that blanks itself reads as "every request is gone". But three of them returned in silence,
// without even a console.error, and the "refreshed …" stamp simply stopped moving. A frozen
// sheet and a live one then look identical.
//
// The Direct Orders sheet proved what that costs: a feed token revoked on 2026-08-05 left it
// showing that day's figures for eighteen days, refreshing every minute the whole time, looking
// perfectly normal. This sheet is fed by the same kind of revocable link and had the same hole.
//
// So a failed refresh now turns row 2 into a red banner naming when the data froze and why the
// last attempt failed; the next good refresh puts the ordinary subtitle back. Painted only when
// the state CHANGES, so a long outage costs nothing per minute.
//
// Only cells already holding a live "refreshed …" stamp are ever touched, so a tab carrying a
// fixed description cannot be overwritten by the warning.
var FEED_STATE_KEY = "phoenixFeedState";
var LAST_GOOD_KEY = "phoenixLastGoodStamp";
var STALE_MARKER = "⚠ STALE";
var STALE_BG = "#B91C1C";
var STALE_FG = "#FFFFFF";

/** The subtitle cells that carry a live refresh stamp, and are therefore safe to repaint. */
function stampedSubtitles(ss) {
  var out = [];
  for (var i = 0; i < TAB_ORDER.length; i++) {
    var sheet = ss.getSheetByName(TAB_ORDER[i]);
    if (!sheet) continue;
    var cell = sheet.getRange(ROW_SUBTITLE, 1);
    var text = String(cell.getValue() || "");
    if (text.indexOf("refreshed ") === -1 && text.indexOf(STALE_MARKER) !== 0) continue;
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
    // Keyed on the reason too, so a 403 that becomes a network outage repaints with the new
    // cause instead of leaving the first explanation up for ever.
    var state = "stale:" + reason;
    if (props.getProperty(FEED_STATE_KEY) === state) return;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return;
    var frozenAt = props.getProperty(LAST_GOOD_KEY);
    var now = Utilities.formatDate(new Date(), TZ, "dd MMM yyyy, HH:mm");
    var message = STALE_MARKER + " — these figures stopped updating "
      + (frozenAt ? "on " + frozenAt : "at some point before this script was updated")
      + " (Cairo). Last attempt " + now + " failed: " + reason
      + ". Still retrying every minute (hourly overnight); this line clears itself the moment the feed answers.";
    var targets = stampedSubtitles(ss);
    for (var i = 0; i < targets.length; i++) {
      targets[i].sheet.getRange(ROW_SUBTITLE, 1, 1, targets[i].cols).setBackground(STALE_BG);
      targets[i].cell
        .setValue(message)
        .setFontColor(STALE_FG)
        .setFontStyle("normal")
        .setFontWeight("bold");
    }
    props.setProperty(FEED_STATE_KEY, state);
  } catch (err) {
    console.error("Could not paint the stale banner (the refresh failure above is the real problem): " + err);
  }
}

/**
 * Record a good refresh, and take the banner down if one is up.
 *
 * Called AFTER the tabs are drawn, so their own fresh subtitles win. A tab this pass did not
 * rewrite still carries the banner text, and is given a plain stamp rather than a guess at what
 * its description used to say.
 */
function markFeedFresh(ss, stamp) {
  try {
    var props = PropertiesService.getScriptProperties();
    var previous = String(props.getProperty(FEED_STATE_KEY) || "");
    props.setProperty(LAST_GOOD_KEY, stamp);
    if (previous.indexOf("stale:") !== 0) return;
    var targets = stampedSubtitles(ss);
    for (var i = 0; i < targets.length; i++) {
      var cell = targets[i].cell;
      if (targets[i].before.indexOf(STALE_MARKER) === 0) {
        cell.setValue(targets[i].sheet.getName() + " — refreshed " + stamp + " (Cairo)");
      }
      targets[i].sheet.getRange(ROW_SUBTITLE, 1, 1, targets[i].cols).setBackground(BLACK);
      cell.setFontColor(MUTED).setFontStyle("italic").setFontWeight("normal");
    }
    props.setProperty(FEED_STATE_KEY, "ok");
  } catch (err) {
    console.error("Could not clear the stale banner: " + err);
  }
}

// ── The refresh ─────────────────────────────────────────────────────────────────

/** `e` is the time-driven trigger's event, and absent on every other caller — see NIGHT PACING. */
function refreshMarketingRequests(e) {
  var url = feedUrl();
  if (!url) {
    // No FEED_TOKEN configured. Treated exactly like an unreachable feed — leave the sheet alone.
    console.error("No FEED_TOKEN script property is set — nothing to fetch. Project Settings -> Script Properties -> FEED_TOKEN.");
    markFeedStale("no FEED_TOKEN is configured");
    return;
  }
  if (nightTimerTickSkips_(e)) {
    // Not a failure, so no banner: the last fetch is under an hour old and a push still lands now.
    return;
  }
  var response;
  try {
    noteFeedFetch_();
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    console.error("Feed unreachable: " + err);
    markFeedStale("the feed could not be reached");
    return; // network blip — last good data stays on screen
  }
  if (response.getResponseCode() !== 200) {
    // The one that hides: 403 means the share link was revoked or has expired, so this will
    // keep failing every minute for ever until somebody re-points FEED_TOKEN at a live link.
    console.error("Feed returned HTTP " + response.getResponseCode());
    markFeedStale("the feed answered HTTP " + response.getResponseCode()
      + (response.getResponseCode() === 403 ? " (the share link was revoked or has expired)" : ""));
    return; // revoked / expired — same rule
  }

  var bundle;
  try {
    bundle = parseBundle(response.getContentText());
  } catch (err) {
    console.error("Feed could not be parsed: " + err);
    markFeedStale("the feed answered but could not be read");
    return; // unparseable — never clear on a bad parse
  }
  if (!bundle || !bundle.REQUESTS || bundle.REQUESTS.length === 0) {
    markFeedStale("the feed answered but carried no request table");
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  var stamp = Utilities.formatDate(new Date(), TZ, "dd MMM yyyy, HH:mm");

  // ONE signature decides whether any layout work happens at all. It covers every tab's column set,
  // so a feed that gains a column rebuilds everything, and a feed that has not changed rebuilds
  // nothing — which is every refresh but the first.
  // Before anything is drawn: rename any tab still carrying an older, less formal name, so the
  // builders below find the tab that already exists instead of creating a second one beside it.
  migrateLegacyTabNames(ss);

  var signature = buildLayoutSignature(bundle);
  var rebuild = props.getProperty("layoutSignature") !== signature;

  for (var i = 0; i < SECTIONS.length; i++) {
    var grid = bundle[SECTIONS[i].key];
    if (!grid || grid.length === 0) continue;
    writeGridSheet(ss, SECTIONS[i], grid, stamp, rebuild);
  }

  // Key Data rides the same pipeline as every other tab — same banding, borders, totals, status
  // colours and filter — because it IS the Requests rows, narrowed. Giving it its own writer would
  // have meant two code paths that had to be kept looking alike by hand.
  var keyGrid = projectGrid(bundle.REQUESTS, KEY_COLUMNS);
  if (keyGrid.length > 0) {
    writeGridSheet(
      ss,
      { tab: KEY_TAB, subtitle: "The columns a decision actually needs — the other " + (bundle.REQUESTS[0].length - keyGrid[0].length) + " are on Requests" },
      keyGrid,
      stamp,
      rebuild,
    );
  }

  if (rebuild) {
    buildExecutiveSummarySheet(ss, bundle.REQUESTS[0], stamp);
    // Needs the whole grid, not just its header: every chart on that tab is sized to the number of
    // distinct months / lines / regions / statuses actually present.
    buildComparisonSheet(ss, bundle.REQUESTS, stamp);
    buildCoverSheet(ss, bundle.SUMMARY || [], stamp);
    orderTabs(ss, TAB_ORDER);
    props.setProperty("layoutSignature", signature);
  } else {
    // The only thing a routine refresh changes outside the data itself: the "as at" stamps.
    stampSheet(ss, EXEC_TAB, "Everything at a glance — refreshed " + stamp + " (Cairo)");
    stampSheet(ss, COMPARISON_TAB, "Side by side — refreshed " + stamp + " (Cairo)");
    stampSheet(ss, "Cover", "Live — refreshed " + stamp + " (Cairo)");
  }

  // Last, and inside its own try: the archive is a safety net, so a fault in it must never take
  // down the refresh that feeds the live tabs. It runs on EVERY pass, rebuild or not — a change
  // that happened during a rebuild is exactly as worth recording as any other.
  try {
    appendBackup(ss, bundle.REQUESTS, stamp);
  } catch (err) {
    console.error("Backup append failed (live tabs are unaffected): " + err);
  }

  // Last of all, so the tabs' own subtitles are already in place.
  markFeedFresh(ss, stamp);
}

/** Every tab's header row, joined. Changes only when the feed's shape changes. */
function buildLayoutSignature(bundle) {
  var parts = [];
  for (var i = 0; i < SECTIONS.length; i++) {
    var grid = bundle[SECTIONS[i].key];
    parts.push(SECTIONS[i].tab + ":" + (grid && grid.length > 0 ? grid[0].join("|") : ""));
  }
  // KEY_COLUMNS is part of the signature too, so editing that list and running Rebuild layout is
  // not even necessary — changing which columns matter is itself a layout change.
  parts.push(KEY_TAB + ":" + KEY_COLUMNS.join("|"));

  // The Comparison tab's shape is not its columns but how many BARS each chart has. A new month, a
  // new region or a status nobody had used before genuinely changes that layout, so it belongs in
  // the signature exactly as a new feed column does. Everything else — a request's amount changing,
  // ten more requests in a month that already exists — leaves it untouched, which is the common
  // case and still rebuilds nothing.
  var domains = [];
  for (var d = 0; d < COMPARISON_DOMAINS.length; d++) {
    domains.push(COMPARISON_DOMAINS[d] + "=" + distinctCount(bundle.REQUESTS, COMPARISON_DOMAINS[d]));
  }
  parts.push(COMPARISON_TAB + ":" + domains.join(","));

  return parts.join("‖");
}

/**
 * How many distinct non-empty values one column holds — the number of groups its QUERY will return.
 *
 * Counted the same way the QUERY groups (`where Col1 is not null`), so the row budget a block is
 * given and the number of rows it actually spills cannot drift apart.
 */
function distinctCount(grid, label) {
  if (!grid || grid.length < 2) return 0;
  var index = grid[0].indexOf(label);
  if (index < 0) return 0;
  var seen = {};
  var total = 0;
  for (var r = 1; r < grid.length; r++) {
    var value = grid[r][index];
    if (value === undefined || value === null || String(value) === "") continue;
    // Prefixed so a value like "constructor" cannot collide with an Object prototype member.
    var key = "·" + String(value);
    if (!seen[key]) {
      seen[key] = true;
      total++;
    }
  }
  return total;
}

/**
 * Narrow a grid to the named columns, in the order named.
 *
 * Skips a label the feed does not send rather than emitting an empty column: a header standing over
 * nothing reads as "this data is missing", when the truth is that this build of Phoenix never had
 * that field.
 */
function projectGrid(grid, labels) {
  if (!grid || grid.length === 0) return [];
  var header = grid[0];
  var picks = [];
  for (var i = 0; i < labels.length; i++) {
    var index = header.indexOf(labels[i]);
    if (index >= 0) picks.push(index);
  }
  if (picks.length === 0) return [];

  var out = [];
  for (var r = 0; r < grid.length; r++) {
    var row = [];
    for (var p = 0; p < picks.length; p++) {
      row.push(grid[r][picks[p]] === undefined ? "" : grid[r][picks[p]]);
    }
    out.push(row);
  }
  return out;
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
  // Legacy names are already handled by migrateLegacyTabNames() before any builder runs.
  var sheet = ss.getSheetByName(EXEC_TAB);
  if (!sheet) sheet = ss.insertSheet(EXEC_TAB);
  resetSheet(sheet);
  ensureRows(sheet, 120);

  function rangeOf(label) {
    return requestsSpan(header, label);
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

  // Placed ABOVE "Needs attention" on purpose: the alert counts say how many things are
  // wrong, this says what just MOVED — and on 2026-08-05 the thing that mattered was a
  // change nobody had made, not a count that had gone up.
  row = sectionTitle(sheet, row, "Changed most recently");
  row = queryBlock(sheet, row, "Every change this sheet has ever seen, newest first",
    ["When (Cairo)", "Change", "Request", "Row hash"],
    recentChangesFormula(AUDIT_TAB, 25), 25);

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

/**
 * The newest entries in the audit trail, most recent first.
 *
 * The Audit Trail records every version of every row and nobody reads an append-only log. On
 * 2026-08-05 fourteen direct orders flipped to rejected inside 58 minutes — nine of them already
 * approved — and the sheet held every one of those transitions while showing none of them. The
 * owner found it by eye, two hours later.
 *
 * Sorted by ROW POSITION, not by the captured timestamp: the timestamp is a display string whose
 * format has changed across versions of this script, so sorting on it would put "05 Aug" above
 * "22 Jul" and quietly mis-order the very thing this block exists to surface. Row order is append
 * order, which is chronological by construction.
 */
function recentChangesFormula(auditTab, rows) {
  var n = rows || 25;
  var q = "'" + auditTab + "'!";
  return '=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER({' + q + 'A2:D5000,ROW(' + q + 'A2:A5000)},'
    + q + 'A2:A5000<>""),5,FALSE),' + n + ',4),"No changes recorded yet.")';
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

/** `cols` widens the band on a tab whose panel is wider than the Executive Summary's eight. */
function sectionTitle(sheet, row, title, cols) {
  sheet.getRange(row, 2, 1, cols || 8).setBackground(INK);
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
 *
 * `rows` is how many rows to FORMAT and reserve. It defaults to twelve, which is what the Executive
 * Summary's breakdowns have always used. The Comparison tab passes the real group count instead,
 * because a chart bound to this block has to know exactly how tall it is.
 */
function queryBlock(sheet, row, caption, headers, formula, rows) {
  var span = rows || 12;
  sheet.getRange(row, 2).setValue(caption)
    .setFontFamily(FONT).setFontSize(10.5).setFontWeight("bold").setFontColor(SLATE);
  row++;
  sheet.getRange(row, 2, 1, headers.length).setValues([headers])
    .setBackground("#F1F5F9").setFontFamily(FONT).setFontSize(9.5).setFontWeight("bold")
    .setFontColor(SLATE)
    .setBorder(null, null, true, null, null, null, HAIRLINE, SpreadsheetApp.BorderStyle.SOLID);
  row++;
  sheet.getRange(row, 2).setFormula(formula);
  sheet.getRange(row, 2, span, headers.length).setFontFamily(FONT).setFontSize(10);
  sheet.getRange(row, 3, span, 1).setNumberFormat(UNITS_FMT);
  sheet.getRange(row, 4, span, 2).setNumberFormat(VALUE_FMT);
  return row + span + 1;
}

/**
 * The fixed span of one Requests column — 'Requests'!D5:D2004 — or null when the feed never sends
 * that label.
 *
 * Fixed rather than sized to the data, for the reason STABILITY gives at the top of this file: a
 * range that tracked the row count would rewrite every formula each time a request was added.
 */
function requestsSpan(header, label) {
  var index = header.indexOf(label);
  if (index < 0) return null;
  var letter = columnLetter(index + 1);
  return "'Requests'!" + letter + ROW_DATA + ":" + letter + LAST_ROW;
}

/** GROUP BY one column, counting rows and summing two money columns, biggest spend first. */
function groupFormula(header, groupLabel, sumA, sumB) {
  var g = requestsSpan(header, groupLabel),
    a = requestsSpan(header, sumA),
    b = requestsSpan(header, sumB);
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
  var code = requestsSpan(header, "Request code"), acct = requestsSpan(header, "Account/Dr.Name"),
    amt = requestsSpan(header, "Amount"), roi = requestsSpan(header, "Estimated ROI"),
    stat = requestsSpan(header, "Status");
  if (!code || !acct || !amt || !roi || !stat) return '="—"';
  return '=IFERROR(QUERY({' + code + "," + acct + "," + amt + "," + roi + "," + stat + '},'
    + '"select * where Col1 is not null order by Col3 desc limit 10",0),"—")';
}

// ── Comparison ──────────────────────────────────────────────────────────────────

/**
 * The same numbers as shapes.
 *
 * The Executive Summary answers "how much, and where is it stuck". This tab answers the question
 * that follows it — "measured against WHAT" — and it is the only tab with charts on it.
 *
 * Three things make it trustworthy rather than decorative:
 *
 *   1. EVERY CHART IS BOUND TO THE TABLE BESIDE IT. Not to values this script computed and pasted:
 *      to the range the table's QUERY spills into. So the picture and the figures are the same
 *      object seen twice and cannot drift apart, and both follow a filter on Requests together —
 *      filter that tab to one line and every chart here redraws for that line.
 *   2. NOTHING IS TRUNCATED. Each block is sized to the number of groups that actually exist, so no
 *      chart shows a "top N" the reader was not told about, and none shows empty slots for months
 *      that have not happened. That is only possible because COMPARISON_DOMAINS' distinct counts
 *      are part of the layout signature — see buildLayoutSignature.
 *   3. A BLOCK WHOSE COLUMNS THE FEED DOES NOT SEND IS SKIPPED, not drawn empty — the same rule Key
 *      Data follows. An axis standing over nothing reads as "the data is missing" when the truth is
 *      that this build of Phoenix never had the field.
 *
 * Built ONCE, on a rebuild, like every other layout in this file.
 */
function buildComparisonSheet(ss, grid, stamp) {
  if (!grid || grid.length === 0) return;
  var header = grid[0];

  var sheet = ss.getSheetByName(COMPARISON_TAB);
  if (!sheet) sheet = ss.insertSheet(COMPARISON_TAB);
  resetSheet(sheet);

  sheet.setColumnWidth(1, 28);
  sheet.setColumnWidth(2, 240);
  for (var w = 3; w <= 5; w++) sheet.setColumnWidth(w, 150);
  sheet.setColumnWidth(6, 24); // gutter between the table and the chart floating beside it
  for (var c = CHART_COL; c < CHART_COL + 6; c++) sheet.setColumnWidth(c, 92);

  bandTitle(sheet, 12, COMPARISON_TAB, "Side by side — refreshed " + stamp + " (Cairo)");
  sheet.setFrozenRows(2);

  var blocks = comparisonBlocks(header, grid);
  var needed = 6;
  for (var n = 0; n < blocks.length; n++) needed += blockBudget(blocks[n].rows) + 3;
  ensureRows(sheet, needed);

  var row = 4;
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    // 11, not 12: sectionTitle starts at column B, so eleven columns end exactly under the brand
    // band's twelve, which start at column A.
    row = sectionTitle(sheet, row, block.section, 11);

    var top = row;
    // A group count of zero still gets one row, so the block shows the "—" its formula returns
    // rather than asking for a range of no height, which throws.
    var span = Math.max(block.rows, 1);
    var budget = blockBudget(block.rows);
    var next = queryBlock(sheet, top, block.caption, block.headers, block.formula, span);
    if (block.rows > 0) addChart(sheet, top, span, budget, block.chart);
    row = Math.max(next, top + budget + 1);
  }

  sheet.getRange(row, 2)
    .setValue("Every table and every chart on this tab is a live formula over the Requests tab — filter that tab and this whole page follows it.")
    .setFontColor(MUTED).setFontStyle("italic").setFontFamily(FONT).setFontSize(10);
}

/** Rows a block occupies: its own height, or the minimum a chart needs to stay readable. */
function blockBudget(rows) {
  return Math.max(Math.max(rows, 1) + 2, MIN_BLOCK_ROWS);
}

/**
 * The five comparisons, in reading order.
 *
 * Line, region and status also appear as tables on the Executive Summary. That is deliberate and
 * not duplication for its own sake: a chart has to have its source range on the sheet, and the
 * owner's standing rule is that a chart never replaces the table — management reads both.
 */
function comparisonBlocks(header, grid) {
  var blocks = [];

  function has() {
    for (var i = 0; i < arguments.length; i++) {
      if (header.indexOf(arguments[i]) < 0) return false;
    }
    return true;
  }

  if (has("Month", "Amount", "Estimated ROI")) {
    blocks.push({
      section: "Month against month",
      caption: "Spend and estimated return, in calendar order",
      headers: ["Month", "Requests", "Spend (EGP)", "Est. ROI (EGP)"],
      formula: monthTrendFormula(header),
      rows: distinctCount(grid, "Month"),
      chart: { type: "COLUMN", title: "Spend vs estimated return, by month", firstValue: 4, valueCount: 2 }
    });
  }

  if (has("Line", "Amount", "Estimated ROI")) {
    blocks.push({
      section: "Line against line",
      caption: "What each line spends, and what it expects back",
      headers: ["Line", "Requests", "Spend (EGP)", "Est. ROI (EGP)"],
      formula: groupFormula(header, "Line", "Amount", "Estimated ROI"),
      rows: distinctCount(grid, "Line"),
      chart: { type: "COLUMN", title: "Spend vs estimated return, by line", firstValue: 4, valueCount: 2 }
    });
  }

  if (has("Region", "Amount", "Estimated ROI")) {
    blocks.push({
      section: "Region against region",
      caption: "Where the spend lands geographically",
      // Horizontal bars, not columns: region names are long, and the owner's rule is that text is
      // never truncated and never wrapped. On a column chart they would be slanted or clipped.
      headers: ["Region", "Requests", "Spend (EGP)", "Est. ROI (EGP)"],
      formula: groupFormula(header, "Region", "Amount", "Estimated ROI"),
      rows: distinctCount(grid, "Region"),
      chart: { type: "BAR", title: "Spend vs estimated return, by region", firstValue: 4, valueCount: 2 }
    });
  }

  if (has("Line", "Estimated ROI", "Required ROI")) {
    blocks.push({
      section: "Promise against requirement",
      caption: "What each line's requests estimate, against what they had to return to qualify",
      headers: ["Line", "Requests", "Est. ROI (EGP)", "Required ROI (EGP)"],
      formula: groupFormula(header, "Line", "Estimated ROI", "Required ROI"),
      rows: distinctCount(grid, "Line"),
      // The one chart where a shorter first bar is the finding: any line whose estimate sits below
      // its requirement is spending against a return it has already said it will not make.
      chart: { type: "COLUMN", title: "Estimated vs required return, by line", firstValue: 4, valueCount: 2 }
    });
  }

  if (has("Status", "Amount", "Estimated ROI")) {
    blocks.push({
      section: "Where the money is sitting",
      caption: "Spend by the state each request is in",
      headers: ["Status", "Requests", "Spend (EGP)", "Est. ROI (EGP)"],
      formula: groupFormula(header, "Status", "Amount", "Estimated ROI"),
      rows: distinctCount(grid, "Status"),
      chart: {
        type: "PIE", title: "Share of spend by status", firstValue: 4, valueCount: 1,
        colors: [ORANGE, INK, "#F59E0B", SLATE, "#FDBA74", MUTED]
      }
    });
  }

  return blocks;
}

/**
 * The same grouping as groupFormula, ordered by CALENDAR rather than by size.
 *
 * The feed sends Month as the words "August 2026", so every ordering the QUERY itself can offer is
 * the wrong one: by spend it is not a trend at all, and alphabetically April comes before August
 * comes before December. Turning each label back into a real date and sorting on that is the only
 * way this reads as a timeline.
 *
 * A label neither DATEVALUE form can read sorts to the front rather than killing the block. One
 * unparseable month must not blank a year of trend — and IFERROR around the whole formula would do
 * exactly that.
 */
function monthTrendFormula(header) {
  var g = requestsSpan(header, "Month"),
    a = requestsSpan(header, "Amount"),
    b = requestsSpan(header, "Estimated ROI");
  if (!g || !a || !b) return '="—"';

  var query = "QUERY({" + g + "," + a + "," + b + "},"
    + '"select Col1, count(Col2), sum(Col2), sum(Col3) where Col1 is not null '
    + "group by Col1 label count(Col2) '', sum(Col2) '', sum(Col3) ''\",0)";
  var key = 'ARRAYFORMULA(IFERROR(DATEVALUE(INDEX(q,0,1)),IFERROR(DATEVALUE("1 "&INDEX(q,0,1)),0)))';
  return "=IFERROR(LET(q," + query + ",SORT(q," + key + ",TRUE)),\"—\")";
}

/**
 * One chart, floating beside its own table.
 *
 * Bound to the block's spill range, never to values this script computed — so it follows the data
 * on the next recalculation without any refresh touching it, which is the whole STABILITY rule at
 * the top of this file applied to a picture instead of a cell.
 *
 * Its height comes from the block's row budget rather than a constant, so a three-row breakdown
 * gets a short chart instead of one hanging over the section beneath it.
 */
function addChart(sheet, top, span, budget, spec) {
  var dataRow = top + 2;
  var isPie = spec.type === "PIE";

  var builder = sheet.newChart()
    .setChartType(chartType(spec.type))
    .setPosition(top, CHART_COL, 0, 0)
    .addRange(sheet.getRange(dataRow, 2, span, 1))
    .addRange(sheet.getRange(dataRow, spec.firstValue, span, spec.valueCount))
    .setOption("title", spec.title)
    .setOption("useFirstColumnAsDomain", true)
    .setOption("fontName", FONT)
    .setOption("backgroundColor", WHITE)
    .setOption("colors", spec.colors || [ORANGE, INK])
    .setOption("titleTextStyle", { bold: true, color: INK, fontName: FONT, fontSize: 12 })
    .setOption("legend", {
      position: isPie ? "right" : "bottom",
      textStyle: { color: SLATE, fontName: FONT, fontSize: 10 }
    })
    .setOption("width", CHART_WIDTH)
    .setOption("height", Math.max(budget * ROW_PX - 16, 180));

  if (!isPie) {
    // A BAR chart is a COLUMN chart on its side, so its VALUE axis is the horizontal one. Formatting
    // vAxis on both would put the money format on the region names and leave the money axis writing
    // 1,200,000 in full — which is what forces the plot area narrow enough that the bars stop being
    // comparable by eye. "short" renders that as 1.2M.
    var value = {
      format: "short",
      gridlines: { color: HAIRLINE },
      textStyle: { color: SLATE, fontName: FONT, fontSize: 10 }
    };
    var category = { textStyle: { color: SLATE, fontName: FONT, fontSize: 10 } };
    builder
      .setOption("hAxis", spec.type === "BAR" ? value : category)
      .setOption("vAxis", spec.type === "BAR" ? category : value);
  }

  sheet.insertChart(builder.build());
}

function chartType(name) {
  if (name === "BAR") return Charts.ChartType.BAR;
  if (name === "PIE") return Charts.ChartType.PIE;
  return Charts.ChartType.COLUMN;
}

// ── Backup: the append-only change history ──────────────────────────────────────

/**
 * Every version of every request, appended, never overwritten.
 *
 * The live tabs answer "what is true now". This one answers "what did it say before, and when did
 * it change" — the question you actually have when a figure is disputed. Ported from the Direct
 * Orders sheet, which had it first and is the better half of the two designs.
 *
 * A row is appended only when its CONTENT hash differs from the last one recorded for that request,
 * so a request that has not moved costs nothing however long the sheet runs. Only the request code
 * and the hash are read back — keeping that to two columns is what stops the archive slowing the
 * 60-second cycle as it grows past a few thousand rows.
 *
 * Deliberately outside the layout signature: this tab is APPEND-ONLY, so it must never be reset by
 * a rebuild. Losing the history to a styling change would defeat the entire point of keeping it.
 */
function appendBackup(ss, grid, stamp) {
  var header = grid[0];
  var body = grid.slice(1);
  if (!body.length) return;

  var sheet = ss.getSheetByName(AUDIT_TAB);
  if (!sheet) sheet = ss.insertSheet(AUDIT_TAB);
  var META = ["Captured (Cairo)", "Change", "Request code", "Row hash"];

  // Build the header once, on first use. Never rebuilt — see the note above.
  if (sheet.getLastRow() < 1) {
    var head = META.concat(header);
    sheet.getRange(1, 1, 1, head.length)
      .setValues([head])
      .setBackground(INK).setFontColor(WHITE).setFontWeight("bold")
      .setFontFamily(FONT).setFontSize(10.5);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 90);
    sheet.setColumnWidth(3, 240);
    sheet.setColumnWidth(4, 110);
  }

  var lastRow = sheet.getLastRow();
  var seen = {};
  if (lastRow > 1) {
    var known = sheet.getRange(2, 3, lastRow - 1, 2).getValues();
    for (var k = 0; k < known.length; k++) {
      // Later rows overwrite earlier ones, so this ends up holding the MOST RECENT hash per request.
      if (known[k][0]) seen[String(known[k][0])] = String(known[k][1]);
    }
  }

  var codeIndex = header.indexOf("Request code");
  if (codeIndex < 0) return;

  var pending = [];
  for (var r = 0; r < body.length; r++) {
    var row = body[r];
    var code = String(row[codeIndex] || "");
    if (!code) continue;
    var hash = hashRow(row);
    var previous = seen[code];
    if (previous === hash) continue; // unchanged — nothing to record
    pending.push([stamp, previous === undefined ? "new" : "updated", code, hash].concat(row));
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
    .setFontFamily(FONT).setFontSize(10).setFontColor(SLATE);
}

/**
 * A cheap content fingerprint for one row.
 *
 * Not a cryptographic hash and does not need to be — it only has to differ when the row differs.
 * Joined on \u001f (unit separator), a character no spreadsheet cell contains, so "a","bc" and "ab","c" cannot
 * collide the way a comma-joined string would.
 */
function hashRow(row) {
  var text = row.join("\u001f");
  var h = 0;
  for (var i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return String(h);
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
    .setValue("Refreshes every minute (hourly from 23:00 to 08:00 Cairo), and instantly whenever a request changes.")
    .setFontColor(MUTED).setFontStyle("italic").setFontFamily(FONT);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** Update only the "as at" line on a tab that is otherwise never touched by a refresh. */
function stampSheet(ss, name, text) {
  var sheet = ss.getSheetByName(name);
  if (sheet) sheet.getRange(ROW_SUBTITLE, 1).setValue(text);
}

/**
 * Rename any tab still carrying an old name, in place.
 *
 * Runs on EVERY refresh, not only a rebuild, and is deliberately cheap: getSheetByName against a
 * two-entry list costs nothing, and the alternative is a sheet that keeps its old tab forever
 * because the rebuild that would have renamed it never happened to fire.
 *
 * If BOTH names somehow exist, the old one is left alone rather than merged or deleted — two tabs
 * is a confusing morning; silently discarding whichever one held the real history is a bad week.
 */
function migrateLegacyTabNames(ss) {
  for (var i = 0; i < LEGACY_TAB_NAMES.length; i++) {
    var entry = LEGACY_TAB_NAMES[i];
    var legacy = ss.getSheetByName(entry.from);
    if (!legacy) continue;
    if (ss.getSheetByName(entry.to)) {
      console.error("Both '" + entry.from + "' and '" + entry.to + "' exist; leaving the old tab alone rather than guessing which to keep.");
      continue;
    }
    legacy.setName(entry.to);
  }
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
  // Charts survive clear() as well — they float above the grid rather than living in it. Leaving
  // them would stack a second copy of every chart on top of the first on the next rebuild, and the
  // stale one underneath still points at the ranges the old layout used.
  try {
    var charts = sheet.getCharts();
    for (var c = 0; c < charts.length; c++) sheet.removeChart(charts[c]);
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
