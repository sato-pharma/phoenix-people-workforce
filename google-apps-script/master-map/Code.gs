/**
 * Master Map — the script that keeps the sheet alive.
 *
 * This runs INSIDE the spreadsheet, as its owner, on a five-minute timer. That is the whole reason
 * this approach was chosen: Google's org policy blocks service-account key creation on this
 * account, so there is no Google credential anywhere — not in Phoenix, not in Railway, not in the
 * repository. The script already has permission to write this one sheet, and nothing else.
 *
 * WHAT IT DOES EACH TICK
 *
 *   1. Asks Phoenix for a change stamp. Five aggregate queries, no rows. On an unchanged database
 *      this is the entire cost of a tick and the script stops here.
 *   2. When the stamp moves — or once an hour regardless, see below — it asks for a PLAN: one line
 *      per tab with a content hash. Only tabs whose hash actually changed get repainted.
 *   3. Repaints those tabs in slices, saving its place as it goes.
 *
 * WHY THE HOURLY CHECK EXISTS. None of the source tables in Phoenix has an update trigger, so the
 * stamp only moves when application code says so. A pharmacy edited by hand-applied SQL — routine
 * in this repo — would not move it. The hourly plan fetch compares real content hashes, so
 * anything the stamp misses self-heals within the hour instead of sitting stale forever.
 *
 * WHY IT SAVES ITS PLACE. Apps Script kills an execution at six minutes. A full repaint of all
 * eleven tabs is longer than that, so the work is a queue in Script Properties: each tick does as
 * much as it can, then the next tick picks up exactly where it stopped. Nothing is left half
 * painted, because a tab is only marked done once its last slice has landed.
 */

// ---------------------------------------------------------------------------------------------
// Settings. Set the first two by hand in Project Settings -> Script Properties. Never commit them.
// ---------------------------------------------------------------------------------------------

/** Base URL of Phoenix, no trailing slash. e.g. https://phoenix-hr.satopharma.com */
const PROP_BASE_URL = "PHOENIX_BASE_URL";
/** The shared secret, matching MASTER_MAP_SYNC_TOKEN in Phoenix's environment. */
const PROP_TOKEN = "PHOENIX_TOKEN";

/** State the script manages itself — do not edit these by hand. */
const PROP_STAMP = "MM_STAMP";
const PROP_HASHES = "MM_HASHES";
const PROP_QUEUE = "MM_QUEUE";
const PROP_LAST_FULL = "MM_LAST_FULL_CHECK";
const PROP_ORDER = "MM_ORDER";

/** Stop this far into the six-minute limit and let the next tick continue. */
const DEADLINE_MS = 4.5 * 60 * 1000;

/** Force a full content comparison at least this often, whatever the stamp says. */
const FULL_CHECK_EVERY_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

/**
 * Run this ONCE by hand, from the Apps Script editor.
 *
 * It checks the settings really work before installing the timer, so a typo in the URL or token
 * surfaces here rather than as a silently dead sheet three days later.
 */
function setup() {
  const stamp = fetchJson("/api/sales/master-map/sheet?probe=1").stamp;
  if (!stamp) throw new Error("Phoenix answered, but returned no stamp. Check the token.");

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "syncMasterMap") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("syncMasterMap").timeBased().everyMinutes(5).create();

  Logger.log("Connected to Phoenix. Stamp: " + stamp);
  Logger.log("Timer installed — the sheet now refreshes itself every 5 minutes.");
}

/** Repaint everything on the next tick, whatever the hashes say. */
function forceFullResync() {
  const properties = PropertiesService.getScriptProperties();
  properties.deleteProperty(PROP_HASHES);
  properties.deleteProperty(PROP_STAMP);
  properties.deleteProperty(PROP_QUEUE);
  Logger.log("Cleared. The next tick repaints every tab.");
}

/** Stop the sheet refreshing itself. */
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "syncMasterMap") ScriptApp.deleteTrigger(trigger);
  });
  Logger.log("Timer removed. The sheet no longer refreshes on its own.");
}

/** The timer's entry point. */
function syncMasterMap() {
  const lock = LockService.getScriptLock();
  // A long repaint can still be running when the next tick fires. Skip rather than double-paint.
  if (!lock.tryLock(5000)) {
    Logger.log("A sync is already running; skipping this tick.");
    return;
  }
  try {
    runSync(Date.now() + DEADLINE_MS);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------------------------
// The work
// ---------------------------------------------------------------------------------------------

function runSync(deadline) {
  const properties = PropertiesService.getScriptProperties();
  let queue = readJson(properties, PROP_QUEUE, []);

  if (queue.length === 0) {
    queue = planWork(properties);
    if (queue.length === 0) return;
  }

  const hashes = readJson(properties, PROP_HASHES, {});

  while (queue.length > 0 && Date.now() < deadline) {
    const job = queue[0];

    // Don't start a tab we are unlikely to finish. A tab is only half-visible while it is being
    // painted, so it is better to leave last sync's correct version up for another five minutes
    // than to tear it down and run out of time. A tab too big for a whole window is started
    // anyway — otherwise it would never be painted at all.
    if (job.part === "clear") {
      const estimate = (job.valueChunks + job.requestChunks + 1) * 2500;
      if (Date.now() + estimate > deadline && estimate < DEADLINE_MS) break;
    }

    const outcome = paintTab(job, deadline);

    if (outcome === "restart") {
      // The data moved underneath us. Drop everything and re-plan on the next tick rather than
      // stitching one tab together out of two different snapshots.
      Logger.log("Phoenix changed mid-repaint — restarting on the next tick.");
      properties.deleteProperty(PROP_QUEUE);
      properties.deleteProperty(PROP_STAMP);
      return;
    }
    if (outcome === "paused") break;

    hashes[job.title] = job.hash;
    queue.shift();
    Logger.log("Finished " + job.title + " (" + job.rows + " rows)");
  }

  properties.setProperty(PROP_HASHES, JSON.stringify(hashes));
  properties.setProperty(PROP_QUEUE, JSON.stringify(queue));

  if (queue.length === 0) {
    orderTabs(properties);
    Logger.log("Sheet is up to date.");
  } else {
    Logger.log(queue.length + " tab(s) still to paint; continuing on the next tick.");
  }
}

/**
 * Put the tabs back in the order Phoenix lists them.
 *
 * A tab this script had to create lands at the END of the workbook, so without this the finder
 * tab and any newly added region would sit after everything else — and the order would drift
 * again every time a region appears. Only reached once the queue has emptied, so it costs one
 * request per repaint rather than one per tick.
 *
 * Done through the REST API rather than moveActiveSheet(), which would yank whichever tab the
 * owner happens to be reading out from under him.
 */
function orderTabs(properties) {
  const order = readJson(properties, PROP_ORDER, []);
  if (order.length === 0) return;

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const requests = [];
  for (let index = 0; index < order.length; index += 1) {
    const sheet = spreadsheet.getSheetByName(order[index]);
    if (!sheet) continue;
    requests.push({
      updateSheetProperties: {
        fields: "index",
        properties: { index: index, sheetId: sheet.getSheetId() },
      },
    });
  }
  if (requests.length > 0) sheetsBatchUpdate(spreadsheet.getId(), requests);
}

/** Decide what actually needs repainting. Returns the queue of tab jobs. */
function planWork(properties) {
  const storedStamp = properties.getProperty(PROP_STAMP);
  const lastFull = Number(properties.getProperty(PROP_LAST_FULL) || 0);
  const dueForFullCheck = Date.now() - lastFull > FULL_CHECK_EVERY_MS;

  if (!dueForFullCheck) {
    const stamp = fetchJson("/api/sales/master-map/sheet?probe=1").stamp;
    if (stamp && stamp === storedStamp) return [];
  }

  const plan = fetchJson("/api/sales/master-map/sheet?plan=1");
  properties.setProperty(PROP_LAST_FULL, String(Date.now()));
  // Remember the full reading order, not just the tabs that changed — the reorder happens after
  // the queue drains, by which point the plan is long gone.
  properties.setProperty(
    PROP_ORDER,
    JSON.stringify(plan.tabs.map(function (tab) { return tab.title; })),
  );

  const hashes = readJson(properties, PROP_HASHES, {});
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const queue = [];

  for (let index = 0; index < plan.tabs.length; index += 1) {
    const tab = plan.tabs[index];
    if (hashes[tab.title] === tab.hash) continue;
    queue.push({
      chunk: 0,
      hash: tab.hash,
      part: "clear",
      requestChunks: tab.requestChunks,
      rows: tab.rows,
      sheetId: ensureTab(spreadsheet, tab.title, tab.rows, tab.columns),
      stamp: plan.stamp,
      title: tab.title,
      valueChunks: tab.valueChunks,
    });
  }

  properties.setProperty(PROP_STAMP, plan.stamp);
  Logger.log(
    queue.length === 0
      ? "Checked every tab against Phoenix — nothing changed."
      : "Repainting: " + queue.map(function (job) { return job.title; }).join(", "),
  );
  return queue;
}

/**
 * Paint one tab, resuming from wherever it stopped.
 *
 * THE ORDER MATTERS: clear, then text, then formatting. Each step is a state the owner can open
 * the sheet and see. Clearing and formatting before writing the text would leave a beautifully
 * banded EMPTY tab for as long as the write takes, which reads as data loss; this way the worst
 * he can catch is correct text that is not styled yet.
 *
 * Returns "done", "paused" (out of time, the job remembers its place) or "restart" (Phoenix's
 * data moved, so the slices no longer belong to one snapshot).
 */
function paintTab(job, deadline) {
  const spreadsheetId = SpreadsheetApp.getActiveSpreadsheet().getId();

  if (job.part === "clear") {
    const slice = fetchSlice(job);
    if (slice.restart) return "restart";
    if (slice.requests && slice.requests.length > 0) sheetsBatchUpdate(spreadsheetId, slice.requests);
    job.part = "values";
    job.chunk = 0;
  }

  while (job.part === "values" && job.chunk < job.valueChunks) {
    if (Date.now() >= deadline) return "paused";
    const slice = fetchSlice(job);
    if (slice.restart) return "restart";
    if (slice.values && slice.values.length > 0) {
      const range = "'" + job.title.replace(/'/g, "''") + "'!A" + (slice.startRow + 1);
      sheetsValuesUpdate(spreadsheetId, range, slice.values);
    }
    job.chunk += 1;
  }

  if (job.part === "values") {
    job.part = "requests";
    job.chunk = 0;
  }

  while (job.chunk < job.requestChunks) {
    if (Date.now() >= deadline) return "paused";
    const slice = fetchSlice(job);
    if (slice.restart) return "restart";
    if (slice.requests && slice.requests.length > 0) sheetsBatchUpdate(spreadsheetId, slice.requests);
    job.chunk += 1;
  }

  return "done";
}

function fetchSlice(job) {
  return fetchJson(
    "/api/sales/master-map/sheet?tab=" +
      encodeURIComponent(job.title) +
      "&part=" +
      job.part +
      "&chunk=" +
      job.chunk +
      "&sheetId=" +
      job.sheetId +
      "&stamp=" +
      encodeURIComponent(job.stamp),
  );
}

/** Create the tab if it is missing and grow it before anything is written into it. */
function ensureTab(spreadsheet, title, rowsNeeded, columnsNeeded) {
  let sheet = spreadsheet.getSheetByName(title);
  if (!sheet) sheet = spreadsheet.insertSheet(title);

  // A values write past the last row is rejected outright, and formatting past it is silently
  // clipped — which reads as "the formatting didn't work" rather than as a size problem.
  const wanted = Math.max(rowsNeeded + 20, 1000);
  if (sheet.getMaxRows() < wanted) sheet.insertRowsAfter(sheet.getMaxRows(), wanted - sheet.getMaxRows());

  // The width comes from the plan, because the widest tab has grown twice now (eleven columns, then
  // fourteen with the district managers) and a hardcoded number here fails as a REJECTED WRITE on
  // whichever tab outgrew it — not as a narrow tab. The +2 is slack so one more column does not.
  const columns = Math.max(Number(columnsNeeded) || 0, 12) + 2;
  if (sheet.getMaxColumns() < columns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
  }

  return sheet.getSheetId();
}

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

/**
 * Call the Google Sheets REST API directly, with this script's own OAuth token.
 *
 * NOT the "advanced Sheets service". That would be the obvious way to do this, but the advanced
 * service is not offered in every Apps Script project's service picker — it was missing from this
 * one — and a script that only works when a dropdown happens to list an entry is a script that
 * breaks silently when someone recreates it. This route needs nothing enabled: the manifest already
 * asks for the spreadsheets scope, and getOAuthToken hands over a token carrying it.
 *
 * Retries on 429 and 5xx. Google allows 60 writes a minute per user and a full repaint sits close
 * to that line, so a retry is the difference between a sync that finishes and one that throws away
 * everything it had already painted.
 */
function sheetsCall(method, path, payload) {
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = UrlFetchApp.fetch("https://sheets.googleapis.com/v4/spreadsheets" + path, {
      contentType: "application/json",
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      method: method,
      muteHttpExceptions: true,
      payload: JSON.stringify(payload),
    });
    const code = response.getResponseCode();
    if (code >= 200 && code < 300) return JSON.parse(response.getContentText() || "{}");

    lastError = code + " " + response.getContentText().slice(0, 300);
    if (code !== 429 && code < 500) break;
    Utilities.sleep(2000 * Math.pow(2, attempt));
  }
  throw new Error("Google Sheets rejected " + method + " " + path + ": " + lastError);
}

function sheetsBatchUpdate(spreadsheetId, requests) {
  return sheetsCall("post", "/" + spreadsheetId + ":batchUpdate", { requests: requests });
}

function sheetsValuesUpdate(spreadsheetId, range, values) {
  return sheetsCall(
    "put",
    "/" + spreadsheetId + "/values/" + encodeURIComponent(range) + "?valueInputOption=RAW",
    { values: values },
  );
}

function readJson(properties, key, fallback) {
  const raw = properties.getProperty(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

/** GET from Phoenix, retrying the failures that are worth retrying. */
function fetchJson(path) {
  const properties = PropertiesService.getScriptProperties();
  const base = properties.getProperty(PROP_BASE_URL);
  const token = properties.getProperty(PROP_TOKEN);
  if (!base) throw new Error("Set " + PROP_BASE_URL + " in Project Settings -> Script Properties.");
  if (!token) throw new Error("Set " + PROP_TOKEN + " in Project Settings -> Script Properties.");

  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = UrlFetchApp.fetch(base.replace(/\/+$/, "") + path, {
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    if (code === 200) return JSON.parse(response.getContentText());

    lastError = code + " " + response.getContentText().slice(0, 300);
    // 401 and 404 will not fix themselves; anything else is worth another try.
    if (code === 401 || code === 404 || code === 400) break;
    Utilities.sleep(2000 * Math.pow(2, attempt));
  }
  throw new Error("Phoenix request failed (" + path + "): " + lastError);
}
