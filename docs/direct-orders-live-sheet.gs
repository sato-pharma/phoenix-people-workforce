/**
 * Phoenix Workforce — Direct Orders live Google Sheet
 * ==================================================================================
 * Keeps the owner's Google Sheet in step with the share-link feed. It carries the
 * downloadable Direct Orders .xlsx faithfully -- the same columns, the same Phoenix
 * styling, the same totals -- and then adds to it.
 *
 * NO COUNTS IN THIS COMMENT, DELIBERATELY. It used to say "the same three tabs, the
 * same 39 columns", and both had quietly gone stale: the columns are whatever
 * DIRECT_ORDER_REPORT_COLUMNS holds (45 on 2026-10-03, and the .xlsx reads the SAME
 * array, which is what keeps the two from ever quoting different totals), and the
 * tabs grew past the workbook's three. A number written here cannot be checked by
 * anything, so it rots silently and the next reader believes it; the array and
 * TAB_ORDER below can be read, so they are the answer.
 *
 *   From the .xlsx   Cover · Direct Orders · Status Breakdown ("By Status" there)
 *   Added since      Executive Summary · Comparison · Audit Trail
 *   Not a report tab  _Phoenix notes (do not delete), hidden
 *
 * The Audit Trail is the one that is NOT a mirror of the feed -- see its own builder.
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
 *   builds every tab in TAB_ORDER. The feed itself answers in ~1.5s with no caching,
 *   so the sheet is effectively live. Overnight (23:00–08:00 Cairo) the timer fetches
 *   once an hour instead — see NIGHT PACING below — while a push still lands at once.
 *
 * SETUP (once)
 *   1. Extensions -> Apps Script
 *   2. Delete the placeholder code, paste this file, Save
 *   3. Project Settings -> Script Properties -> add FEED_TOKEN with the token Phoenix minted.
 *      It is deliberately not in this file: see feedToken() below.
 *   4. Choose `installTrigger` in the function dropdown, click Run
 *   5. Authorise when Google asks (it is asking about YOUR OWN script)
 *   Refreshes every minute from then on (hourly overnight), including while the sheet is closed.
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
 *
 *   It no longer does that in SILENCE. Row 2 turns into a red STALE banner naming when
 *   the figures stopped moving and why the last attempt failed, and clears itself the
 *   moment the feed answers again. Stale data you can see is safe; stale data that looks
 *   live is what cost eighteen days once already.
 */

// ── Configuration ────────────────────────────────────────────────────────────────
var FEED_BASE = "https://phoenix-hr.satopharma.com/api/share/direct-orders/";

/**
 * The feed token lives in a Script Property, and NOWHERE in this file.
 *
 * It used to ship here as a "bootstrap" value, on the reasoning that rotating would revoke it and
 * make the committed copy worthless. Rotation did happen and the old token is revoked — but a dead
 * credential in a file is still a credential in a file. It reads to the next person as a live one,
 * it invites the next setup to paste a live one beside it, and git keeps whatever is written here
 * for good. So the slot is gone rather than emptied.
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

// ── Premium layout (2026-08-05) ─────────────────────────────────────────────────
// Fixed geometry, matching the Marketing sheet so the two read as one system.
//
// The TOTAL bar sits ABOVE the data. Below it, the bar moves every time an order is approved or
// expires, which forces a rewrite on every refresh — the churn this file already fights everywhere
// else. Above the data it never moves, it stays inside the frozen panes so it is visible while you
// scroll 43 columns, and it is still outside the filter range.
var ROW_TITLE = 1;
var ROW_SUBTITLE = 2;
var ROW_TOTAL = 3;
var ROW_HEADER = 4;
var ROW_DATA = 5;
var MAX_DATA_ROWS = 2000;
var LAST_ROW = ROW_DATA + MAX_DATA_ROWS - 1;

// ─────────────────────────────────────────────────────────────────────────────
// The team's own columns (owner request, 2026-08-06).
//
// Phoenix owns columns 1..cols and rewrites them every minute. These sit AFTER that block, so the
// refresh never touches them — `setValues` and the tail `clearContent` are both bounded by `cols`.
//
// THE PART THAT MATTERS: a note must belong to an ORDER, not to a row. Rows move on every refresh
// — an order is approved, a new one arrives, and row 12 is now a different request. A note left at
// row 12 would silently re-attach to somebody else's order, which in a report about money is worse
// than losing it. So notes are keyed by Request ID: read before the rewrite, written back to
// whatever row that id landed on.
//
// They are also mirrored into a hidden sheet, because an order can leave this report entirely
// (approved, expired, filtered out) and come back later. Without the store its note would be gone
// for good the moment it dropped off the visible list.
// ─────────────────────────────────────────────────────────────────────────────

// Bumped whenever the LOOK changes. Styling lives in buildOrdersFrame, which only runs when the
// column set changes — so a pure restyle alters no header, no rebuild fires, and a sheet that has
// already been built keeps the old look forever. Pasting a new script would appear to do nothing,
// which is exactly how the editable block shipped invisible. The stamp is the trigger.
var STYLE_VERSION = "2026-08-06-centred";
var STYLE_STAMP_KEY = "phoenixOrdersStyleVersion";

var NOTES_TAB = "_Phoenix notes (do not delete)";
var NOTES_KEY_HEADER = "Request ID";

var EDITABLE_COLUMNS = [
  // PROPOSED, not booked — and the distance between those two words is the whole reason this
  // column is here rather than making Phoenix's own "Sales month" typeable.
  //
  // Setting the real sales month is what INJECTS THE SALES (spec C2, the golden rule), and only
  // the Finance Manager or a Super Admin may do it. Two ways to get that wrong, both worse than a
  // second column: made editable in place, a month typed here is erased within the minute while
  // the person walks away believing the order is booked — a false belief about whether money
  // moved. Made to write back, anyone holding the share link could inject sales, and the link is
  // deliberately shared with people who have no Phoenix account at all.
  //
  // So the team writes what they think, Phoenix keeps what is true, and the two sit side by side
  // where the gap is visible. Finance still books it in Phoenix.
  { label: "Month proposed (team)", width: 18 },
  { label: "Note", width: 40 },
  { label: "Follow-up owner", width: 18 },
  { label: "Follow-up date", width: 14 },
  { label: "Status (team)", width: 16, choices: ["", "Chasing", "Promised", "Paid", "Disputed", "Escalated", "Done"] },
  { label: "Collection / payment note", width: 34 },
  { label: "Extra", width: 22 },
];

var INK = "#0F172A";
var HAIRLINE = "#E2E8F0";
var TILE_BG = "#FFF7ED";
var ZEBRA_A = "#FFFFFF";
var ZEBRA_B = "#FFF8F1";
var TOTAL_BG = "#1F2937";
var PCT_FMT = "0.0%";

/** Every column carrying a state word. */
var STATUS_COLUMNS = ["Status", "Awaiting step", "Deal type"];

/**
 * Colour by MEANING, not by column: green done, red needs a decision, amber waiting, blue in
 * flight, grey parked. Set in ONE call — setConditionalFormatRules REPLACES the list, so appending
 * per column would leave only the last column coloured.
 */
var STATUS_RULES = [
  { match: ["approved", "Approved", "collected", "Collected"], bg: "#DCFCE7", fg: "#166534" },
  { match: ["rejected", "Rejected", "expired", "Expired", "reversed", "Reversed"], bg: "#FEE2E2", fg: "#991B1B" },
  { match: ["held", "Held", "pending_validation", "Pending validation"], bg: "#FEF3C7", fg: "#92400E" },
  { match: ["pending_approval", "Pending approval", "submitted", "Submitted"], bg: "#DBEAFE", fg: "#1E40AF" },
  { match: ["draft", "Draft", "withdrawn", "Withdrawn", "cancelled", "Cancelled"], bg: "#F1F5F9", fg: "#475569" }
];

/**
 * The held fuse, coloured by how much of it is left (spec B6 = 14 days).
 *
 * Red inside 4 days, amber inside 8. On 2026-08-05 eleven orders worth 509,736 EGP were all due to
 * expire on the same day and nothing on the sheet said so — a number going red is the cheapest
 * possible way for that to never be a surprise again.
 */
/** Money and quantity columns that get a magnitude gradient. See applyStatusColours. */
var GRADIENT_COLUMNS = ["Sales value (EGP)", "Qty (units)", "Paid (EGP)", "Remaining (EGP)"];

var EXPIRY_COLUMN = "Days to expiry";
var EXPIRY_RED_WITHIN_DAYS = 4;
var EXPIRY_AMBER_WITHIN_DAYS = 8;

/**
 * Columns whose value is a URL and must render as a CLICKABLE cell.
 *
 * A blank stays blank — deliberately. Writing "Open photo" over an empty URL produces a link that
 * goes nowhere, and a reader who clicks a dead link concludes the system lost the photograph rather
 * than that none was ever taken. Most orders legitimately have none: a storefront photo exists only
 * where a pharmacy had to be validated by capture.
 */
var LINK_LABELS = {
  "Evidence photo link": "📷 Open photo"
};

var EXEC_TAB = "Executive Summary";
var COMPARISON_TAB = "Comparison";
var STATUS_TAB = "Status Breakdown";
var AUDIT_TAB = "Audit Trail";

/**
 * Tabs this sheet shipped under an earlier, less formal name.
 *
 * The owner's rule (2026-08-05): every tab name reads as something that belongs in a board pack.
 * "God Mode" and "Backup" did not; "By Status" was a fragment rather than a title.
 *
 * Each entry RENAMES the existing tab rather than letting a new one appear beside it. Inserting a
 * fresh tab would strand the old one, frozen at whatever it last showed — and for the audit trail
 * that would also abandon the history, which is the only thing it exists to keep.
 */
var LEGACY_TAB_NAMES = [
  { from: "God Mode", to: EXEC_TAB },
  { from: "By Status", to: STATUS_TAB },
  { from: "Backup", to: AUDIT_TAB }
];

var TAB_ORDER = [EXEC_TAB, COMPARISON_TAB, "Direct Orders", STATUS_TAB, "Cover", AUDIT_TAB];

// ── Staleness banner ──────────────────────────────────────────────────────────
//
// The fail-safe above is right: when a refresh fails the last good data stays on screen,
// because a sheet that blanks itself reads as "every order is gone". What was wrong is that it
// failed SILENTLY. The only record was a console.error nobody opens, and the "updated …"
// subtitle simply stopped moving — a frozen sheet and a live one look identical at a glance.
//
// Not theoretical. A feed token revoked on 2026-08-05 left one of these sheets showing that
// day's figures for eighteen days, refreshing every single minute the whole time, looking
// perfectly normal, until the rejected requests turned up in a production log.
//
// So a failed refresh now turns row 2 into a red banner naming the moment the data froze and
// why the last attempt failed; the next good refresh turns it back into the ordinary subtitle.
// Painted only when the state CHANGES, so a long outage still costs nothing per minute.
//
// Only cells that already hold a live "updated …" stamp are ever touched. The Cover and Status
// tabs carry fixed descriptions, and overwriting one of those would be the banner causing the
// very damage it exists to warn about.
var FEED_STATE_KEY = "phoenixFeedState";
var LAST_GOOD_KEY = "phoenixLastGoodStamp";
var STALE_MARKER = "⚠ STALE";
var STALE_BG = "#B91C1C";
var STALE_FG = "#FFFFFF";
var STAMPED_TABS = [EXEC_TAB, COMPARISON_TAB, "Direct Orders"];

/** The subtitle cells that carry a live refresh stamp, and are therefore safe to repaint. */
function stampedSubtitles(ss) {
  var out = [];
  for (var i = 0; i < STAMPED_TABS.length; i++) {
    var sheet = ss.getSheetByName(STAMPED_TABS[i]);
    if (!sheet) continue;
    var cell = sheet.getRange(ROW_SUBTITLE, 1);
    var text = String(cell.getValue() || "");
    // Belt and braces: a cell that is neither a stamp nor our own banner is somebody else's
    // content and is left completely alone.
    if (text.indexOf("updated ") === -1 && text.indexOf(STALE_MARKER) !== 0) continue;
    out.push({ cell: cell, cols: Math.max(1, sheet.getLastColumn()), sheet: sheet });
  }
  return out;
}

/**
 * Say, on the face of the sheet, that what it shows is no longer live.
 *
 * Never throws: this runs on the failure path, and a banner that breaks the trigger would turn
 * a stale sheet into a dead one.
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
    var now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
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
 * Called AFTER the tabs are drawn, so the builders' own fresh subtitles win. A tab a builder
 * did not rewrite still carries the banner text, so that one is restored from what it said
 * before the outage rather than guessed at.
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
      if (String(cell.getValue() || "").indexOf(STALE_MARKER) === 0) {
        cell.setValue(targets[i].sheet.getName() + " — updated " + stamp + " (Cairo)");
      }
      targets[i].sheet.getRange(ROW_SUBTITLE, 1, 1, targets[i].cols).setBackground(BLACK);
      cell.setFontColor(MUTED).setFontStyle("italic").setFontWeight("normal");
    }
    props.setProperty(FEED_STATE_KEY, "ok");
  } catch (err) {
    console.error("Could not clear the stale banner: " + err);
  }
}

// Chart geometry, shared with the Marketing sheet so the two read as one system.
var CHART_COL = 7;      // charts float to the right of the table, clear of it
var CHART_WIDTH = 540;
var MIN_BLOCK_ROWS = 14;
var ROW_PX = 21;

// ── Night pacing ────────────────────────────────────────────────────────────────
//
// Phoenix pushes to doPost the moment a direct order changes, so the 1-minute timer is only the
// safety net for a push that never arrived. At night nobody reads this sheet and almost nothing
// changes, yet the timer went on fetching the whole feed sixty times an hour. Measured on the night
// of 30–31 October 2026, this sheet and its Marketing twin were about 2,100 of the ~9,000 requests
// an hour Phoenix sent its database between 23:00 and 08:00 Cairo — the largest share nobody needed.
//
// So between NIGHT_START_HOUR and NIGHT_END_HOUR (Cairo) a TIMER tick fetches only when an hour has
// passed since the last fetch. Everything else fetches at once, at any hour: a push, a token
// rotation (also a push), "Refresh now", installTrigger, and a run from the editor. The daytime
// timer is untouched. A failing feed still shows its STALE banner overnight — within the hour.
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
  ScriptApp.newTrigger("refreshDirectOrders").timeBased().everyMinutes(1).create();
  refreshDirectOrders();
}

/**
 * Push endpoint (spec D5e). Phoenix POSTs here the moment a direct order changes, so the sheet
 * updates immediately instead of waiting up to 60 seconds for the next timer tick — or up to an
 * hour overnight, when the timer is paced (see NIGHT PACING).
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

/**
 * The trigger target. Fetch, parse, then rebuild every tab in TAB_ORDER.
 *
 * `e` is the time-driven trigger's event, and absent on every other caller — see NIGHT PACING.
 */
function refreshDirectOrders(e) {
  var url = feedUrl();
  if (!url) {
    // Say which of the two failures this is. "No token configured" and "the feed refused us" look
    // identical from the sheet, and confusing them costs an hour.
    console.error("No FEED_TOKEN script property is set — nothing to fetch. Project Settings -> Script Properties -> FEED_TOKEN.");
    markFeedStale("no FEED_TOKEN is configured");
    return; // keep whatever is on screen
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
    return; // keep whatever is on screen
  }
  if (response.getResponseCode() !== 200) {
    console.error("Feed returned HTTP " + response.getResponseCode());
    // 403 is the one that hides: the link was revoked or has expired, so this will keep
    // failing every minute for ever until somebody re-points FEED_TOKEN at a live link.
    markFeedStale("the feed answered HTTP " + response.getResponseCode()
      + (response.getResponseCode() === 403 ? " (the share link was revoked or has expired)" : ""));
    return;
  }

  var bundle = parseBundle(response.getContentText("UTF-8"));
  // Refuse to redraw on a payload that lost its shape — better stale than wrong.
  if (!bundle.orders.length || bundle.orders[0].length < 2) {
    console.error("Feed parsed but carried no order table; keeping existing data.");
    markFeedStale("the feed answered but carried no order table");
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
  // Before anything is drawn: rename any tab still carrying an older, less formal name, so the
  // builders below find the tab that already exists instead of creating a second one beside it.
  migrateLegacyTabNames(ss);

  var created = [];
  buildOrdersSheet(ss, bundle.orders, stamp, created);
  buildByStatusSheet(ss, bundle.byStatus, created);
  buildCoverSheet(ss, bundle.summary, bundle.orders.length - 1, stamp, created);

  // The panel is pure live formulas over the Direct Orders tab, so it needs building only when it
  // does not exist yet or the column set moved — never on a routine refresh.
  if (!ss.getSheetByName(EXEC_TAB) || !headerMatches(ss.getSheetByName("Direct Orders"), bundle.orders[0], ROW_HEADER)) {
    buildExecutiveSummarySheet(ss, bundle.orders[0], stamp, created);
    // Needs the whole grid, not just its header: every chart is sized to the number of distinct
    // statuses / lines / products / regions actually present, so nothing is silently truncated.
    buildComparisonSheet(ss, bundle.orders, stamp, created);
  } else {
    ss.getSheetByName(EXEC_TAB).getRange(ROW_SUBTITLE, 1)
      .setValue("Everything at a glance — updated " + stamp + " (Cairo)");
    var cmp = ss.getSheetByName(COMPARISON_TAB);
    if (cmp) cmp.getRange(ROW_SUBTITLE, 1).setValue("Side by side — updated " + stamp + " (Cairo)");
  }

  // Last, and inside its own try: the backup is a safety net, so a fault in it must never take
  // down the refresh that feeds the live tabs.
  try {
    appendBackup(ss, bundle.orders, stamp, created);
  } catch (err) {
    console.error("Backup append failed (live tabs are unaffected): " + err);
  }

  if (created.length) orderTabs(ss, TAB_ORDER);

  // Last of all, so the builders' own subtitles are already in place.
  markFeedFresh(ss, stamp);
}

// ── Feed parsing ────────────────────────────────────────────────────────────────

/**
 * Split the one payload into its three sections.
 *
 * The feed marks them with `#SUMMARY` / `#BYSTATUS` / `#ORDERS` lines and returns
 * them together, so every tab built from this one payload is guaranteed to describe
 * the same instant -- which is the point, and is why the section count here is three
 * while the tab count is not. A cover reading "14 orders" above a table listing 15 is
 * exactly the sort of quiet inconsistency that makes people stop trusting a report.
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

/** The main table: every column the feed sent, frozen header, filter, banded rows, grand total. */
function buildOrdersSheet(ss, grid, stamp, created) {
  var header = grid[0];
  var body = grid.slice(1);
  var cols = header.length;

  var sheet = getOrCreateSheet(ss, "Direct Orders", created);

  // Rebuild the STRUCTURE only when it is actually wrong — first run, or the column set changed
  // (e.g. the 39-to-43 held-clock upgrade). On every other refresh only the values are rewritten,
  // which is what stops the sheet flickering, jumping and resizing itself once a minute.
  // The team's own columns, captured BEFORE anything else touches the sheet.
  //
  // Ordering is load-bearing twice over. The pairing of row to Request ID is only true until the
  // rewrite below reorders everything — and buildOrdersFrame calls resetSheet, which would wipe
  // the block before it could be read. So this runs first, ahead of both.
  var keyCol = requestIdCol(header);
  var store = readNotesStore(ss);
  var captured = captureEditableByRequestId(sheet, header, cols);
  for (var capturedId in captured) {
    if (captured.hasOwnProperty(capturedId)) store[capturedId] = captured[capturedId];
  }

  // A restyle changes no header, so headerMatches alone would never repaint an existing sheet.
  var restyled = PropertiesService.getDocumentProperties().getProperty(STYLE_STAMP_KEY) !== STYLE_VERSION;
  var rebuild = restyled || !headerMatches(sheet, header, ROW_HEADER);
  if (rebuild) {
    buildOrdersFrame(sheet, header, cols);
    PropertiesService.getDocumentProperties().setProperty(STYLE_STAMP_KEY, STYLE_VERSION);
  }
  // Painted independently of Phoenix's header, because on a sheet whose own columns have not
  // changed — which is every existing sheet — `rebuild` is false and buildOrdersFrame never runs.
  // The block would sit there unstyled and unlabelled forever, which is exactly what happened the
  // first time this shipped.
  else if (!editableFrameReady(sheet, cols)) buildEditableFrame(sheet, cols);
  ensureRows(sheet, LAST_ROW);

  // ── the only part that runs every minute ──
  if (body.length) {
    var values = [];
    for (var r = 0; r < body.length && r < MAX_DATA_ROWS; r++) {
      var row = [];
      for (var c = 0; c < cols; c++) {
        var raw = c < body[r].length ? body[r][c] : "";
        if (LINK_LABELS[header[c]]) {
          // A HYPERLINK formula is the only cell type that both shows a friendly label and
          // navigates on a single click.
          row.push(raw ? '=HYPERLINK("' + String(raw).replace(/"/g, '""') + '","' + LINK_LABELS[header[c]] + '")' : "");
        } else {
          row.push(coerce(header[c], raw));
        }
      }
      values.push(row);
    }
    sheet.getRange(ROW_DATA, 1, values.length, cols).setValues(values);
    // Orders disappear (approved, expired, reversed). Clear the tail only — formatting is untouched,
    // so those rows keep their banding and are ready for the next, longer refresh.
    var tail = LAST_ROW - (ROW_DATA + values.length) + 1;
    if (tail > 0) sheet.getRange(ROW_DATA + values.length, 1, tail, cols).clearContent();

    // Repaint the team's notes against the row each order now occupies. Both ranges above are
    // bounded by `cols`, so neither the write nor the tail clear ever reached this block.
    var orderedIds = [];
    for (var i = 0; i < values.length; i++) {
      orderedIds.push(keyCol ? String(body[i][keyCol - 1] || "").trim() : "");
    }
    paintEditable(sheet, cols, orderedIds, store);
  } else {
    sheet.getRange(ROW_DATA, 1, MAX_DATA_ROWS, cols).clearContent();
    paintEditable(sheet, cols, [], store);
  }
  // Written AFTER the repaint, so a mid-refresh failure leaves the store as it was rather than
  // half-updated.
  writeNotesStore(ss, store);

  sheet.getRange(ROW_SUBTITLE, 1).setValue("Every direct order, live — updated " + stamp + " (Cairo)");
}

/**
 * Everything that is NOT data. First build, or when the column set changes — never on a refresh.
 */
/** Where the team's block starts, and how wide it is. Always immediately after Phoenix's columns. */
function editableStartCol(cols) {
  return cols + 1;
}

/** The Request ID column index (1-based) within Phoenix's own block. */
function requestIdCol(header) {
  for (var i = 0; i < header.length; i++) {
    if (String(header[i]).trim() === NOTES_KEY_HEADER) return i + 1;
  }
  return 0;
}

function notesSheet(ss) {
  var sheet = ss.getSheetByName(NOTES_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(NOTES_TAB);
    sheet.getRange(1, 1, 1, 1 + EDITABLE_COLUMNS.length)
      .setValues([[NOTES_KEY_HEADER].concat(EDITABLE_COLUMNS.map(function (c) { return c.label; }))]);
    sheet.hideSheet();
  }
  return sheet;
}

/** id -> [note, owner, date, status, payNote, extra], from the durable store. */
function readNotesStore(ss) {
  var sheet = notesSheet(ss);
  var last = sheet.getLastRow();
  var out = {};
  if (last < 2) return out;
  var rows = sheet.getRange(2, 1, last - 1, 1 + EDITABLE_COLUMNS.length).getValues();
  for (var r = 0; r < rows.length; r++) {
    var id = String(rows[r][0] || "").trim();
    if (id) out[id] = rows[r].slice(1);
  }
  return out;
}

function writeNotesStore(ss, store) {
  var sheet = notesSheet(ss);
  var ids = Object.keys(store);
  var values = [];
  for (var i = 0; i < ids.length; i++) values.push([ids[i]].concat(store[ids[i]]));
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, 1 + EDITABLE_COLUMNS.length).clearContent();
  if (values.length) sheet.getRange(2, 1, values.length, 1 + EDITABLE_COLUMNS.length).setValues(values);
}

/**
 * Read what people have typed on the CURRENT sheet, before the rewrite moves every row.
 *
 * Keyed off the ids as they are on the sheet right now — not off the incoming data — because that
 * is the only pairing that is still true at this moment.
 */
function captureEditableByRequestId(sheet, header, cols) {
  var keyCol = requestIdCol(header);
  var out = {};
  if (!keyCol) return out;
  // A first run, or a sheet narrower than the block, has nothing to read yet — and getRange past
  // the sheet's own bounds throws, which would abort the whole refresh over an empty note.
  var needRows = ROW_DATA + MAX_DATA_ROWS - 1;
  var needCols = editableStartCol(cols) + EDITABLE_COLUMNS.length - 1;
  if (sheet.getMaxRows() < needRows || sheet.getMaxColumns() < needCols) return out;
  var ids = sheet.getRange(ROW_DATA, keyCol, MAX_DATA_ROWS, 1).getValues();
  var block = sheet.getRange(ROW_DATA, editableStartCol(cols), MAX_DATA_ROWS, EDITABLE_COLUMNS.length).getValues();
  for (var r = 0; r < ids.length; r++) {
    var id = String(ids[r][0] || "").trim();
    if (!id) continue;
    var row = block[r];
    var hasAny = false;
    for (var c = 0; c < row.length; c++) if (String(row[c] || "").trim() !== "") { hasAny = true; break; }
    if (hasAny) out[id] = row;
  }
  return out;
}

/** Lay the team's notes back out in the NEW row order. */
function paintEditable(sheet, cols, orderedIds, store) {
  var startCol = editableStartCol(cols);
  ensureColumns(sheet, startCol + EDITABLE_COLUMNS.length - 1);
  var values = [];
  for (var r = 0; r < orderedIds.length; r++) {
    var saved = store[orderedIds[r]];
    values.push(saved ? saved.slice(0, EDITABLE_COLUMNS.length) : new Array(EDITABLE_COLUMNS.length).fill(""));
  }
  if (values.length) sheet.getRange(ROW_DATA, startCol, values.length, EDITABLE_COLUMNS.length).setValues(values);
  var tail = LAST_ROW - (ROW_DATA + values.length) + 1;
  if (tail > 0) sheet.getRange(ROW_DATA + values.length, startCol, tail, EDITABLE_COLUMNS.length).clearContent();
}

/**
 * The team's block: its own header, its own colour, and a dropdown on the status column.
 *
 * Deliberately styled UNLIKE Phoenix's header. The owner chose not to lock the Phoenix columns, so
 * the only thing stopping someone typing where it will be erased within the minute is being able
 * to SEE which block is theirs. A different colour and the word "yours" does that work.
 */
/** Is the team's block already labelled? Cheap enough to ask on every refresh. */
function editableFrameReady(sheet, cols) {
  var start = editableStartCol(cols);
  var width = EDITABLE_COLUMNS.length;
  if (sheet.getMaxColumns() < start + width - 1) return false;
  if (sheet.getMaxRows() < ROW_HEADER) return false;
  var current = sheet.getRange(ROW_HEADER, start, 1, width).getValues()[0];
  for (var i = 0; i < width; i++) {
    if (String(current[i]) !== String(EDITABLE_COLUMNS[i].label)) return false;
  }
  return true;
}

function buildEditableFrame(sheet, cols) {
  var start = editableStartCol(cols);
  var width = EDITABLE_COLUMNS.length;
  ensureColumns(sheet, start + width - 1);
  ensureRows(sheet, LAST_ROW);

  // The house palette, not a near-miss of it. This shipped with three raw hex values that appear
  // nowhere else in the workbook — a muddy orange beside ORANGE, an off-white beside TILE_BG — and
  // that is precisely what reads as bolted on rather than built in.
  sheet.getRange(ROW_TOTAL, start, 1, width)
    .setBackground(AMBER).setFontColor(AMBER_TEXT).setFontFamily(FONT)
    .setFontWeight("bold").setFontSize(9)
    .setVerticalAlignment("middle").setHorizontalAlignment("center")
    .setBorder(null, null, true, null, null, null, ORANGE, SpreadsheetApp.BorderStyle.SOLID_THICK);
  sheet.getRange(ROW_TOTAL, start).setValue("YOURS ▸ kept on refresh");

  sheet.getRange(ROW_HEADER, start, 1, width)
    .setValues([EDITABLE_COLUMNS.map(function (c) { return c.label; })])
    .setBackground(ORANGE).setFontColor(WHITE).setFontWeight("bold")
    .setFontFamily(FONT).setFontSize(9.5)
    .setVerticalAlignment("middle").setHorizontalAlignment("center").setWrap(true)
    .setBorder(true, true, true, true, true, true, WHITE, SpreadsheetApp.BorderStyle.SOLID);

  for (var i = 0; i < width; i++) {
    sheet.setColumnWidth(start + i, (EDITABLE_COLUMNS[i].width || 18) * 7);
    var body = sheet.getRange(ROW_DATA, start + i, MAX_DATA_ROWS, 1);
    body.setBackground(TILE_BG).setFontFamily(FONT).setFontSize(10).setFontColor(SLATE)
      .setVerticalAlignment("middle").setHorizontalAlignment("center")
      .setBorder(true, true, true, true, true, true, GRID, SpreadsheetApp.BorderStyle.SOLID);
    if (EDITABLE_COLUMNS[i].choices) {
      body.setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(EDITABLE_COLUMNS[i].choices, true)
          // Not rejected: a value the list has not caught up with is a fact about the work, and
          // refusing it would send the person back to typing in a Phoenix column where it is lost.
          .setAllowInvalid(true)
          .build(),
      );
    } else {
      body.setWrap(true);
    }
  }
}

function buildOrdersFrame(sheet, header, cols) {
  resetSheet(sheet);
  ensureRows(sheet, LAST_ROW);
  bandTitle(sheet, cols, "Direct Orders", "Every direct order, live");

  // ── the sticky TOTAL bar, ABOVE the data so it never moves ──
  var totalRange = sheet.getRange(ROW_TOTAL, 1, 1, cols);
  totalRange.setBackground(TOTAL_BG).setFontColor(WHITE).setFontFamily(FONT)
    .setFontWeight("bold").setFontSize(10.5)
    .setVerticalAlignment("middle").setHorizontalAlignment("center")
    .setBorder(null, null, true, null, null, null, ORANGE, SpreadsheetApp.BorderStyle.SOLID_THICK);
  sheet.setRowHeight(ROW_TOTAL, 30);
  sheet.getRange(ROW_TOTAL, 1).setValue("TOTAL ▸");
  for (var t = 0; t < cols; t++) {
    if (TOTALLED.indexOf(header[t]) === -1) continue;
    var letter = columnLetter(t + 1);
    // SUBTOTAL(109) = sum IGNORING filtered-out rows. Plain SUM would show the whole company while
    // the reader looked at one region — wrong in the most convincing possible way, because it is
    // correct for a selection nobody made.
    sheet.getRange(ROW_TOTAL, t + 1)
      .setFormula("=SUBTOTAL(109," + letter + ROW_DATA + ":" + letter + LAST_ROW + ")")
      .setNumberFormat(NUMERIC[header[t]] || VALUE_FMT)
      .setHorizontalAlignment("center");
  }

  buildEditableFrame(sheet, cols);

  // ── header ──
  sheet.getRange(ROW_HEADER, 1, 1, cols)
    .setValues([header])
    .setBackground(INK).setFontColor(WHITE).setFontWeight("bold")
    .setFontFamily(FONT).setFontSize(10.5)
    .setVerticalAlignment("middle").setHorizontalAlignment("center").setWrap(true)
    .setBorder(true, true, true, true, true, true, ORANGE, SpreadsheetApp.BorderStyle.SOLID);
  sheet.setRowHeight(ROW_HEADER, 38);

  // Band, total and header all stay on screen; the first column stays on screen sideways. The
  // frozen column is only possible because bandTitle PAINTS the band instead of merging it.
  sheet.setFrozenRows(ROW_HEADER);
  sheet.setFrozenColumns(1);

  // ── body formatting, over the FIXED range ──
  var body = sheet.getRange(ROW_DATA, 1, MAX_DATA_ROWS, cols);
  body.setFontFamily(FONT).setFontSize(10).setFontColor(SLATE)
    .setVerticalAlignment("middle")
    // Every cell centred (owner's rule, 2026-08-06). The one cost worth knowing: centred money no
    // longer lines up digit-under-digit, so a column is scanned rather than compared at a glance.
    // The number FORMATS below are what keep the figures readable instead.
    .setHorizontalAlignment("center")
    .setWrap(false) // owner's rule: never wrap, never truncate with an ellipsis
    .setBorder(true, true, true, true, true, true, HAIRLINE, SpreadsheetApp.BorderStyle.SOLID);

  for (var n = 0; n < cols; n++) {
    var fmt = NUMERIC[header[n]];
    if (fmt) {
      sheet.getRange(ROW_DATA, n + 1, MAX_DATA_ROWS, 1).setNumberFormat(fmt).setHorizontalAlignment("center");
    }
  }

  applyZebra(sheet, cols);
  applyStatusColours(sheet, header);
  sizeColumns(sheet, header, cols);

  // Header + data only. Including the TOTAL bar would let a filter hide or re-sort the grand total,
  // which is how a report ends up showing a number that belongs to nothing on screen. That is
  // exactly why the bar sits above the data rather than below it.
  try {
    sheet.getRange(ROW_HEADER, 1, MAX_DATA_ROWS + 1, cols).createFilter();
  } catch (err) {
    // a filter already exists — cosmetic, never fail the build over it
  }
}

/**
 * Zebra striping as real BANDING, not per-row background fills.
 *
 * The previous version computed a full backgrounds matrix and wrote it on EVERY refresh — one of
 * the things that made the sheet feel alive in the wrong way. Banding is a single sheet-level
 * object: one call, written once, and it re-stripes itself as rows are filtered. Painted
 * backgrounds also go wrong the moment anything is filtered, because the stripes stay with the
 * ROWS rather than with what is visible.
 */
function applyZebra(sheet, cols) {
  try {
    var existing = sheet.getBandings();
    for (var i = 0; i < existing.length; i++) existing[i].remove();
    sheet.getRange(ROW_DATA, 1, MAX_DATA_ROWS, cols)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
    var banding = sheet.getBandings()[0];
    if (banding) banding.setFirstRowColor(ZEBRA_A).setSecondRowColor(ZEBRA_B);
  } catch (err) {
    // banding is cosmetic — never fail the build over it
  }
}

/** Colour every status column by meaning, and the held fuse by how much of it is left. */
function applyStatusColours(sheet, header) {
  var rules = [];
  var statusRanges = [];
  for (var i = 0; i < header.length; i++) {
    if (STATUS_COLUMNS.indexOf(String(header[i])) >= 0) {
      statusRanges.push(sheet.getRange(ROW_DATA, i + 1, MAX_DATA_ROWS, 1));
    }
  }
  if (statusRanges.length) {
    for (var r = 0; r < STATUS_RULES.length; r++) {
      for (var m = 0; m < STATUS_RULES[r].match.length; m++) {
        rules.push(
          SpreadsheetApp.newConditionalFormatRule()
            .whenTextEqualTo(STATUS_RULES[r].match[m])
            .setBackground(STATUS_RULES[r].bg)
            .setFontColor(STATUS_RULES[r].fg)
            .setRanges(statusRanges)
            .build()
        );
      }
    }
  }

  var expiryIndex = header.indexOf(EXPIRY_COLUMN);
  if (expiryIndex >= 0) {
    var expiry = [sheet.getRange(ROW_DATA, expiryIndex + 1, MAX_DATA_ROWS, 1)];
    // Red first: rules are evaluated in order and the first match wins, so an order 2 days from
    // expiry must not be caught by the amber "under 8" rule on the way past.
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenNumberLessThanOrEqualTo(EXPIRY_RED_WITHIN_DAYS)
        .setBackground("#FEE2E2").setFontColor("#991B1B").setBold(true)
        .setRanges(expiry).build()
    );
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenNumberLessThanOrEqualTo(EXPIRY_AMBER_WITHIN_DAYS)
        .setBackground("#FEF3C7").setFontColor("#92400E")
        .setRanges(expiry).build()
    );
  }

  // ── Value gradients ──────────────────────────────────────────────────────────────────────
  // A colour SCALE, not data bars. Sheets draws data bars from zero across the cell, so on a
  // column where one order is 133,056 and the next is 1,309 every small order renders as an
  // invisible sliver — the reader sees one bar and thirteen blanks. A three-point scale keeps
  // every row readable and still makes the big ones jump out.
  //
  // Deliberately pale: these sit in the same eyeline as the status colours, which carry meaning
  // rather than magnitude, and a strong gradient would out-shout them.
  for (var g = 0; g < GRADIENT_COLUMNS.length; g++) {
    var gi = header.indexOf(GRADIENT_COLUMNS[g]);
    if (gi < 0) continue;
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .setGradientMinpoint("#FFFFFF")
        .setGradientMidpointWithValue("#FFEDD5", SpreadsheetApp.InterpolationType.PERCENTILE, "50")
        .setGradientMaxpoint("#FDBA74")
        .setRanges([sheet.getRange(ROW_DATA, gi + 1, MAX_DATA_ROWS, 1)])
        .build()
    );
  }

  sheet.setConditionalFormatRules(rules);
}

/**
 * The one tab to look at.
 *
 * Every figure is a LIVE FORMULA over the Direct Orders tab, never a value this script computed and
 * pasted. It therefore stays right in the minute between refreshes and — more usefully —
 * recalculates when the reader filters Direct Orders, making it a lens on whatever slice they are
 * looking at rather than a fixed company summary.
 *
 * Built ONCE, like every other frame in this file.
 */
function buildExecutiveSummarySheet(ss, header, stamp, created) {
  var sheet = getOrCreateSheet(ss, EXEC_TAB, created);
  resetSheet(sheet);
  ensureRows(sheet, 120);

  var Q = "'Direct Orders'!";
  function span(label) {
    var index = header.indexOf(label);
    if (index < 0) return null;
    var letter = columnLetter(index + 1);
    return Q + letter + ROW_DATA + ":" + letter + LAST_ROW;
  }
  var rStatus = span("Status");
  var rValue = span("Sales value (EGP)");
  var rQty = span("Qty (units)");
  var rReq = span("Requester");
  var rProduct = span("Product");
  var rExpiry = span(EXPIRY_COLUMN);
  var rId = span("Request ID");

  sheet.setColumnWidth(1, 28);
  sheet.setColumnWidth(2, 260);
  for (var w = 3; w <= 9; w++) sheet.setColumnWidth(w, 160);

  bandTitle(sheet, 9, "Executive Summary", "Everything at a glance — updated " + stamp + " (Cairo)");
  sheet.setFrozenRows(2);

  var row = 4;
  row = tileRow(sheet, row, [
    { label: "Orders", formula: rId ? "=COUNTA(" + rId + ")" : "=0", fmt: UNITS_FMT },
    { label: "Total value (EGP)", formula: rValue ? "=SUM(" + rValue + ")" : "=0", fmt: VALUE_FMT },
    { label: "Units", formula: rQty ? "=SUM(" + rQty + ")" : "=0", fmt: UNITS_FMT },
    { label: "Approved (EGP)", formula: (rStatus && rValue) ? '=SUMIF(' + rStatus + ',"approved",' + rValue + ')' : "=0", fmt: VALUE_FMT }
  ]);

  // The held block is the reason this tab exists. On 2026-08-05 it would have read: 11 orders,
  // 509,736 EGP, 98% of everything, all expiring the same day.
  row = tileRow(sheet, row, [
    { label: "HELD orders", formula: rStatus ? '=COUNTIF(' + rStatus + ',"held")' : "=0", fmt: UNITS_FMT },
    { label: "HELD value (EGP)", formula: (rStatus && rValue) ? '=SUMIF(' + rStatus + ',"held",' + rValue + ')' : "=0", fmt: VALUE_FMT },
    {
      label: "Held share of value",
      // IFERROR, not a bare divide: an empty report makes the denominator zero, and a #DIV/0! on
      // the headline tile makes the whole panel look broken.
      formula: (rStatus && rValue) ? '=IFERROR(SUMIF(' + rStatus + ',"held",' + rValue + ')/SUM(' + rValue + '),0)' : "=0",
      fmt: PCT_FMT
    },
    {
      label: "Soonest expiry (days)",
      // MIN over a filtered range, so an approved order's blank clock cannot win the minimum.
      formula: (rExpiry && rStatus) ? '=IFERROR(MIN(IF(' + rStatus + '="held",' + rExpiry + ')),"—")' : '="—"',
      fmt: "#,##0.0",
      arrayFormula: true
    }
  ]);

  row = sectionTitle(sheet, row, "Where the exposure sits");
  row = queryBlock(sheet, row, "Held value by requester", ["Requester", "Orders", "Held value (EGP)"],
    heldGroupFormula(header, "Requester"));
  row = queryBlock(sheet, row, "Held value by product", ["Product", "Orders", "Held value (EGP)"],
    heldGroupFormula(header, "Product"));

  row = sectionTitle(sheet, row, "Everything by status");
  row = queryBlock(sheet, row, "By status", ["Status", "Orders", "Value (EGP)"],
    groupFormula(header, "Status"));

  // Placed ABOVE "Needs attention" on purpose: the alert counts say how many things are
  // wrong, this says what just MOVED — and on 2026-08-05 the thing that mattered was a
  // change nobody had made, not a count that had gone up.
  row = sectionTitle(sheet, row, "Changed most recently");
  row = queryBlock(sheet, row, "Every status change this sheet has ever seen, newest first",
    ["When (Cairo)", "Change", "Request", "Row hash"],
    recentChangesFormula(AUDIT_TAB, 25), 25);

  row = sectionTitle(sheet, row, "Needs attention");
  var alertFirst = row;
  var alerts = [
    ["Held orders expiring within " + EXPIRY_RED_WITHIN_DAYS + " days",
      (rStatus && rExpiry) ? '=COUNTIFS(' + rStatus + ',"held",' + rExpiry + ',"<=' + EXPIRY_RED_WITHIN_DAYS + '")' : "=0"],
    ["Held orders expiring within " + EXPIRY_AMBER_WITHIN_DAYS + " days",
      (rStatus && rExpiry) ? '=COUNTIFS(' + rStatus + ',"held",' + rExpiry + ',"<=' + EXPIRY_AMBER_WITHIN_DAYS + '")' : "=0"],
    ["Already expired", rStatus ? '=COUNTIF(' + rStatus + ',"expired")' : "=0"],
    ["Rejected", rStatus ? '=COUNTIF(' + rStatus + ',"rejected")' : "=0"],
    ["Reversed", rStatus ? '=COUNTIF(' + rStatus + ',"reversed")' : "=0"]
  ];
  for (var a = 0; a < alerts.length; a++) {
    sheet.getRange(row, 2).setValue(alerts[a][0]).setFontFamily(FONT).setFontSize(10.5).setFontColor(SLATE);
    sheet.getRange(row, 3).setFormula(alerts[a][1]).setNumberFormat(UNITS_FMT)
      .setFontFamily(FONT).setFontWeight("bold").setHorizontalAlignment("left");
    sheet.getRange(row, 2, 1, 2).setBorder(null, null, true, null, null, null, HAIRLINE, SpreadsheetApp.BorderStyle.SOLID);
    row++;
  }
  try {
    sheet.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenNumberGreaterThan(0)
        .setBackground("#FEE2E2").setFontColor("#991B1B").setBold(true)
        .setRanges([sheet.getRange(alertFirst, 3, alerts.length, 1)])
        .build()
    ]);
  } catch (err) { /* cosmetic */ }

  row += 2;
  sheet.getRange(row, 2)
    .setValue("Every figure here is a live formula over the Direct Orders tab — filter that tab and this panel follows it.")
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
    var cell = sheet.getRange(row, c);
    // MIN(IF(...)) needs ARRAYFORMULA to evaluate the condition across the range rather than
    // against a single cell. Everything else is a plain aggregate and must NOT be wrapped.
    cell.setFormula(tiles[i].arrayFormula
      ? "=ARRAYFORMULA(" + tiles[i].formula.substring(1) + ")"
      : tiles[i].formula);
    cell.setNumberFormat(tiles[i].fmt)
      .setFontFamily(FONT).setFontSize(20).setFontWeight("bold").setFontColor(INK)
      .setVerticalAlignment("bottom");
    sheet.getRange(row + 1, c).setValue(tiles[i].label)
      .setFontFamily(FONT).setFontSize(9.5).setFontColor(SLATE).setVerticalAlignment("top");
  }
  sheet.setRowHeight(row, 36);
  sheet.setRowHeight(row + 1, 20);
  return row + 3;
}

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
 * on its own and the script never leaves last week's longer table half-erased under this week's
 * shorter one.
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

function spanOf(header, label) {
  var index = header.indexOf(label);
  if (index < 0) return null;
  var letter = columnLetter(index + 1);
  return "'Direct Orders'!" + letter + ROW_DATA + ":" + letter + LAST_ROW;
}

/** GROUP BY one column over every order, counting and summing value, biggest first. */
function groupFormula(header, groupLabel) {
  var g = spanOf(header, groupLabel), v = spanOf(header, "Sales value (EGP)");
  if (!g || !v) return '="—"';
  // "is not null" drops the empty tail of the fixed range, which would otherwise show as a nameless
  // group holding a total the reader cannot act on.
  return '=IFERROR(QUERY({' + g + "," + v + '},'
    + '"select Col1, count(Col2), sum(Col2) where Col1 is not null group by Col1 '
    + "order by sum(Col2) desc label count(Col2) '', sum(Col2) ''\",0),\"—\")";
}

/** The same, restricted to HELD orders — the concentration that actually carries risk. */
function heldGroupFormula(header, groupLabel) {
  var g = spanOf(header, groupLabel), v = spanOf(header, "Sales value (EGP)"), s = spanOf(header, "Status");
  if (!g || !v || !s) return '="—"';
  return '=IFERROR(QUERY({' + g + "," + v + "," + s + '},'
    + '"select Col1, count(Col2), sum(Col2) where Col3 = \'held\' and Col1 is not null group by Col1 '
    + "order by sum(Col2) desc label count(Col2) '', sum(Col2) ''\",0),\"—\")";
}

// ── Comparison ──────────────────────────────────────────────────────────────────

/**
 * The same numbers as SHAPES.
 *
 * Executive Summary answers "what is the state of things". This one answers the question that
 * follows it — "measured against WHAT" — and it is the only tab with charts on it.
 *
 * Three things make it trustworthy rather than decorative:
 *
 *   1. EVERY CHART IS BOUND TO THE TABLE BESIDE IT. Not to values this script computed and pasted:
 *      to the range the table's QUERY spills into. So the picture and the figures are the same
 *      object seen twice and cannot drift apart, and both follow a filter on Direct Orders together
 *      — filter that tab to one region and every chart here redraws for that region.
 *   2. NOTHING IS TRUNCATED. Each block is sized to the number of groups that actually exist, so no
 *      chart shows a "top N" the reader was not told about, and none shows empty slots.
 *   3. A BLOCK WHOSE COLUMNS THE FEED DOES NOT SEND IS SKIPPED, not drawn empty. An axis standing
 *      over nothing reads as "the data is missing" when the truth is that this build never had the
 *      field.
 *
 * Built ONCE, on a rebuild, like every other layout in this file.
 */
function buildComparisonSheet(ss, grid, stamp, created) {
  if (!grid || grid.length === 0) return;
  var header = grid[0];

  var sheet = getOrCreateSheet(ss, COMPARISON_TAB, created);
  resetSheet(sheet);

  sheet.setColumnWidth(1, 28);
  sheet.setColumnWidth(2, 260);
  for (var w = 3; w <= 5; w++) sheet.setColumnWidth(w, 150);
  sheet.setColumnWidth(6, 24); // gutter between the table and the chart floating beside it
  for (var c = CHART_COL; c < CHART_COL + 6; c++) sheet.setColumnWidth(c, 92);

  bandTitle(sheet, 12, COMPARISON_TAB, "Side by side — updated " + stamp + " (Cairo)");
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
    .setValue("Every table and every chart on this tab is a live formula over the Direct Orders tab — filter that tab and this whole page follows it.")
    .setFontColor(MUTED).setFontStyle("italic").setFontFamily(FONT).setFontSize(10);
}

/** Which comparisons the feed can actually support, in reading order. */
function comparisonBlocks(header, grid) {
  var blocks = [];
  function has() {
    for (var i = 0; i < arguments.length; i++) {
      if (header.indexOf(arguments[i]) < 0) return false;
    }
    return true;
  }

  if (has("Status", "Sales value (EGP)", "Qty (units)")) {
    blocks.push({
      section: "Status against status",
      caption: "Where the money is sitting, and how much of it",
      headers: ["Status", "Orders", "Value (EGP)", "Units"],
      formula: groupTwoFormula(header, "Status", "Sales value (EGP)", "Qty (units)"),
      rows: distinctCount(grid, "Status"),
      chart: { type: "COLUMN", title: "Value and units, by status", firstValue: 4, valueCount: 2 }
    });
  }

  if (has("Line", "Sales value (EGP)", "Qty (units)")) {
    blocks.push({
      section: "Line against line",
      caption: "What each line is selling through direct orders",
      headers: ["Line", "Orders", "Value (EGP)", "Units"],
      formula: groupTwoFormula(header, "Line", "Sales value (EGP)", "Qty (units)"),
      rows: distinctCount(grid, "Line"),
      chart: { type: "COLUMN", title: "Value and units, by line", firstValue: 4, valueCount: 2 }
    });
  }

  if (has("Product", "Sales value (EGP)", "Qty (units)")) {
    blocks.push({
      section: "Product against product",
      caption: "Which products the direct-order channel actually moves",
      // Horizontal bars: product names are long, and the owner's rule is that text is never
      // truncated and never wrapped. On a column chart they would be slanted or clipped.
      headers: ["Product", "Orders", "Value (EGP)", "Units"],
      formula: groupTwoFormula(header, "Product", "Sales value (EGP)", "Qty (units)"),
      rows: distinctCount(grid, "Product"),
      chart: { type: "BAR", title: "Value and units, by product", firstValue: 4, valueCount: 2 }
    });
  }

  if (has("Region", "Sales value (EGP)", "Qty (units)")) {
    blocks.push({
      section: "Region against region",
      caption: "Where the direct-order value lands geographically",
      headers: ["Region", "Orders", "Value (EGP)", "Units"],
      formula: groupTwoFormula(header, "Region", "Sales value (EGP)", "Qty (units)"),
      rows: distinctCount(grid, "Region"),
      chart: { type: "BAR", title: "Value and units, by region", firstValue: 4, valueCount: 2 }
    });
  }

  if (has("Requester", "Sales value (EGP)", "Qty (units)")) {
    blocks.push({
      section: "Requester against requester",
      caption: "Who is raising the direct orders, and for how much",
      headers: ["Requester", "Orders", "Value (EGP)", "Units"],
      formula: groupTwoFormula(header, "Requester", "Sales value (EGP)", "Qty (units)"),
      rows: distinctCount(grid, "Requester"),
      chart: { type: "BAR", title: "Value and units, by requester", firstValue: 4, valueCount: 2 }
    });
  }

  if (has("Requester", "Sales value (EGP)", "Status")) {
    blocks.push({
      section: "Held exposure",
      caption: "Held value by requester — the concentration that actually carries risk",
      headers: ["Requester", "Held orders", "Held value (EGP)"],
      formula: heldGroupFormula(header, "Requester"),
      rows: distinctCount(grid, "Requester"),
      // One series, and red rather than the brand orange: this block is the risk, not the report.
      chart: { type: "BAR", title: "Held value, by requester", firstValue: 4, valueCount: 1, colors: ["#DC2626"] }
    });
  }

  if (has("Deal type", "Sales value (EGP)")) {
    blocks.push({
      section: "Bonus against discount",
      caption: "How the value splits between the two deal types",
      headers: ["Deal type", "Orders", "Value (EGP)"],
      formula: groupFormula(header, "Deal type"),
      rows: distinctCount(grid, "Deal type"),
      chart: { type: "PIE", title: "Value by deal type", firstValue: 4, valueCount: 1 }
    });
  }

  return blocks;
}

/** GROUP BY one column, counting rows and summing TWO numeric columns, biggest first. */
function groupTwoFormula(header, groupLabel, sumA, sumB) {
  var g = spanOf(header, groupLabel), a = spanOf(header, sumA), b = spanOf(header, sumB);
  if (!g || !a || !b) return '="—"';
  return '=IFERROR(QUERY({' + g + "," + a + "," + b + '},'
    + '"select Col1, count(Col2), sum(Col2), sum(Col3) where Col1 is not null group by Col1 '
    + "order by sum(Col2) desc label count(Col2) '', sum(Col2) '', sum(Col3) ''\",0),\"—\")";
}

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
    if (!seen[key]) { seen[key] = true; total++; }
  }
  return total;
}

function blockBudget(rows) {
  return Math.max(Math.max(rows, 1) + 2, MIN_BLOCK_ROWS);
}

function chartType(name) {
  if (name === "BAR") return Charts.ChartType.BAR;
  if (name === "PIE") return Charts.ChartType.PIE;
  return Charts.ChartType.COLUMN;
}

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
    // vAxis on both would put the money format on the product names and leave the money axis writing
    // 1,200,000 in full — which forces the plot area narrow enough that the bars stop being
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

/** The status breakdown, mirroring the .xlsx's second sheet. */
function buildByStatusSheet(ss, grid, created) {
  if (!grid.length) return;
  var sheet = getOrCreateSheet(ss, STATUS_TAB, created);

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
 * Every other tab is a MIRROR: it shows what the feed says right now, so anything the feed
 * stops sending disappears from it. That is correct for a live report and useless as a record.
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

  var sheet = getOrCreateSheet(ss, AUDIT_TAB, created);
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
  // clear() wipes content and formats but NOT merges, banding or conditional-format rules, so a
  // sheet built by an earlier version keeps all three forever — and the merged brand band in
  // particular is exactly what makes setFrozenColumns throw. Strip them first, or a fix in this
  // file never reaches an existing sheet.
  if (sheet.getFilter()) sheet.getFilter().remove();
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
function headerMatches(sheet, header, headerRow) {
  var at = headerRow || 2;
  if (sheet.getLastRow() < at) return false;
  // Judge PHOENIX's own columns, not the sheet's full width.
  //
  // This compared getLastColumn() to header.length, which made the answer depend on anything
  // sitting to the RIGHT of the table — and the team's block sits exactly there. Two failures came
  // out of that one line: while the block was empty the widths matched, so the frame was never
  // built and the columns had no header, no colour and no dropdown; and the moment a note was
  // typed the widths stopped matching, so the whole layout rebuilt EVERY MINUTE — the flicker and
  // the columns resizing mid-read that this design exists to avoid.
  if (sheet.getMaxColumns() < header.length) return false;
  var current = sheet.getRange(at, 1, 1, header.length).getValues()[0];
  for (var i = 0; i < header.length; i++) {
    if (String(current[i]) !== String(header[i])) return false;
  }
  return true;
}

/**
 * Rename any tab still carrying an old name, in place.
 *
 * Runs on EVERY refresh, not only a rebuild, and is deliberately cheap: getSheetByName against a
 * three-entry list costs nothing, and the alternative is a sheet that keeps its old tab forever
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

/** Grow the sheet if someone has deleted rows by hand, or every getRange below would throw. */
function ensureRows(sheet, needed) {
  var have = sheet.getMaxRows();
  if (have < needed) sheet.insertRowsAfter(have, needed - have);
}

/**
 * A new sheet is 26 columns wide; Phoenix's 45 plus the team's 6 need 51. Without this every
 * getRange past the edge throws, and the refresh dies on a sheet that has never been built.
 */
function ensureColumns(sheet, needed) {
  var have = sheet.getMaxColumns();
  if (have < needed) sheet.insertColumnsAfter(have, needed - have);
}

/** The Phoenix two-row brand band: black bar, orange title, muted subtitle. */
function bandTitle(sheet, cols, title, subtitle) {
  // PAINTED, not merged.
  //
  // Merging row 1 across all 43 columns makes Google refuse setFrozenColumns(1) — "you can't freeze
  // columns which contain only part of a merged cell". This file used to answer that by giving up
  // the frozen column, which costs the reader the Status and Requester the moment they scroll
  // right on a deliberately very wide sheet.
  //
  // Filling the row's BACKGROUND and putting the text in an unmerged A1 looks identical: the
  // adjacent band cells are empty, so the title overflows across them the way any long cell does.
  // No merge, so the frozen column survives — and unlike the old comment's fear, overflow renders
  // fine because the text starts inside the frozen pane rather than crossing into it.
  sheet.getRange(1, 1, 1, cols).setBackground(BLACK);
  sheet.getRange(1, 1)
    .setValue(title)
    .setFontColor(ORANGE)
    .setFontWeight("bold")
    .setFontFamily(FONT)
    .setFontSize(subtitle ? 16 : 12)
    .setVerticalAlignment("middle");
  sheet.setRowHeight(1, subtitle ? 40 : 28);

  if (subtitle) {
    sheet.getRange(2, 1, 1, cols).setBackground(BLACK);
    sheet.getRange(2, 1)
      .setValue(subtitle)
      .setFontColor(MUTED)
      .setFontStyle("italic")
      .setFontFamily(FONT)
      .setFontSize(10.5)
      .setVerticalAlignment("middle");
    sheet.setRowHeight(2, 22);
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

/** Put the tabs in a stable, readable order. */
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
