import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The two Google Apps Script sheets in docs/ are the owner's live Direct Orders and Marketing
// Request reports. They fetch a Phoenix share-link feed every minute and, by deliberate design,
// keep the last good data on screen when a fetch fails — a sheet that blanks itself reads as
// "every order is gone", which is worse than stale data.
//
// What that design was missing is the other half: SAYING SO. Until 2026-08-24 a failure produced
// at most a console.error nobody opens, and the "updated …" subtitle simply stopped moving. A
// frozen sheet and a live one looked identical.
//
// That cost eighteen days. A Direct Orders feed token was revoked on 2026-08-05 at 15:22 Cairo;
// the Apps Script trigger kept fetching it once a minute and being refused, and the sheet went on
// showing 5 August figures, looking perfectly normal, until the rejected requests surfaced in a
// production HTTP log on 2026-08-24.
//
// These files are not built, linted or imported by the app, so nothing else in CI looks at them
// at all. This suite is the only thing standing between that fix and a silent regression, so it
// checks both halves: that no failure path returns quietly, and that the banner actually behaves.
const SHEETS = [
  {
    file: "../docs/direct-orders-live-sheet.gs",
    refresh: "function refreshDirectOrders()",
    stampWord: "updated",
    // Every early return in the refresh: no token, unreachable, non-200, empty payload.
    minFailurePaths: 4,
  },
  {
    file: "../docs/marketing-request-live-sheet.gs",
    refresh: "function refreshMarketingRequests()",
    stampWord: "refreshed",
    // As above plus an unparseable payload, which this sheet handles separately.
    minFailurePaths: 5,
  },
];

function readSheet(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** The body of the refresh function, from its signature to the next top-level declaration. */
function refreshBody(source: string, signature: string) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must still exist — the trigger calls it by name`);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n(?:function |\/\/ ──)/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * A fake Spreadsheet, just rich enough to run the two banner functions out of the real .gs file.
 * Records every write so "it repainted" and "it stayed quiet" are both provable.
 */
function fakeSheet(name: string, subtitle: string, lastColumn: number) {
  const cells = new Map<string, unknown>([["2:1", subtitle]]);
  const format = new Map<string, string>();
  const writes: string[] = [];
  const getRange = (row: number, col: number, _numRows = 1, numCols = 1) => {
    const key = `${row}:${col}`;
    const api: Record<string, unknown> = {
      getValue: () => cells.get(key) ?? "",
      setValue(value: unknown) { cells.set(key, value); writes.push("value"); return api; },
      setBackground(value: string) { format.set(`bg:${key}:${numCols}`, value); writes.push("background"); return api; },
      setFontColor(value: string) { format.set(`fg:${key}`, value); return api; },
      setFontStyle(value: string) { format.set(`style:${key}`, value); return api; },
      setFontWeight(value: string) { format.set(`weight:${key}`, value); return api; },
    };
    return api;
  };
  return { cells, format, writes, getName: () => name, getLastColumn: () => lastColumn, getRange };
}

function loadScript(source: string, tabs: Map<string, unknown>, props: Record<string, string>) {
  const sandbox: Record<string, unknown> = {
    console: { error: () => {}, log: () => {} },
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
    isNaN,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) => (key in props ? props[key] : null),
        setProperty: (key: string, value: string) => { props[key] = value; },
      }),
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (name: string) => tabs.get(name) ?? null }) },
    Utilities: { formatDate: () => "2026-08-24 03:00:00" },
    UrlFetchApp: {},
    ScriptApp: {},
    CacheService: {},
    LockService: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox as {
    markFeedStale: (reason: string) => void;
    markFeedFresh: (ss: unknown, stamp: string) => void;
  };
}

export async function runLiveSheetStaleBannerTests() {
  for (const sheet of SHEETS) {
    const source = readSheet(sheet.file);
    const body = refreshBody(source, sheet.refresh);
    const lines = body.split("\n");

    // 1. No silent early return. Every bail-out in the refresh must first say so on the sheet —
    //    this is the actual defect, and it is invisible by nature, so only a check like this
    //    catches it coming back.
    const silent: string[] = [];
    let announced = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*return;/.test(lines[i])) continue;
      const lookback = lines.slice(Math.max(0, i - 5), i).join("\n");
      if (lookback.includes("markFeedStale(")) announced += 1;
      else silent.push(lines[i].trim());
    }
    assert.deepEqual(
      silent,
      [],
      `${sheet.file}: every failure path must call markFeedStale before returning — a refresh that gives up in silence is exactly how a sheet showed 5 August figures for eighteen days while looking perfectly normal. Silent returns found: ${silent.join(" | ")}`,
    );
    assert.ok(
      announced >= sheet.minFailurePaths,
      `${sheet.file}: expected at least ${sheet.minFailurePaths} announced failure paths, found ${announced} — a path was removed rather than fixed`,
    );

    // 2. The recovery half. Without it the banner is permanent and the sheet lies in the other
    //    direction, which is worse than the original bug.
    assert.match(
      body,
      /markFeedFresh\(ss, stamp\)/,
      `${sheet.file}: the success path must call markFeedFresh so the banner comes down again`,
    );

    // 3. Behaviour, driven out of the real file.
    const live = fakeSheet("Requests", `Everything, live — ${sheet.stampWord} 2026-08-05 15:22:00 (Cairo)`, 43);
    const fixedText = "CONFIDENTIAL — internal data, do not forward";
    const fixed = fakeSheet("Cover", fixedText, 2);
    const tabs = new Map<string, unknown>([
      ["Requests", live],
      ["Direct Orders", live],
      ["Executive Summary", live],
      ["Cover", fixed],
    ]);
    const props: Record<string, string> = { phoenixLastGoodStamp: "2026-08-05 15:22:00" };
    const script = loadScript(source, tabs, props);

    script.markFeedStale("the feed answered HTTP 403 (the share link was revoked or has expired)");
    const banner = String(live.cells.get("2:1"));
    assert.ok(
      banner.startsWith("⚠ STALE"),
      `${sheet.file}: a failed refresh must mark the subtitle stale, got: ${banner}`,
    );
    assert.match(banner, /2026-08-05 15:22:00/, `${sheet.file}: the banner must name when the data froze`);
    assert.match(banner, /HTTP 403/, `${sheet.file}: the banner must name why the last attempt failed`);
    assert.equal(live.format.get("bg:2:1:43"), "#B91C1C", `${sheet.file}: the banner must be visible, not just wordy`);

    // A tab whose subtitle is a fixed description must never be overwritten by the warning —
    // the banner destroying real content would be the cure causing the disease.
    assert.equal(fixed.cells.get("2:1"), fixedText, `${sheet.file}: a fixed subtitle must survive untouched`);
    assert.equal(fixed.writes.length, 0, `${sheet.file}: a tab with no live stamp must not be written to at all`);

    // Repeating the same failure must cost nothing: this runs every minute, for ever.
    const settled = live.writes.length;
    script.markFeedStale("the feed answered HTTP 403 (the share link was revoked or has expired)");
    assert.equal(live.writes.length, settled, `${sheet.file}: an unchanged failure must repaint nothing`);

    // A different cause must replace the old explanation rather than leaving a wrong one up.
    script.markFeedStale("the feed could not be reached");
    assert.match(String(live.cells.get("2:1")), /could not be reached/, `${sheet.file}: a new cause must be shown`);

    // Recovery: text, colour, weight and state all go back.
    script.markFeedFresh({ getSheetByName: (name: string) => tabs.get(name) ?? null }, "2026-08-24 03:00:00");
    assert.ok(
      !String(live.cells.get("2:1")).startsWith("⚠ STALE"),
      `${sheet.file}: the banner must come down when the feed answers again`,
    );
    assert.equal(live.format.get("bg:2:1:43"), "#000000", `${sheet.file}: the band must go back to black`);
    assert.equal(live.format.get("weight:2:1"), "normal", `${sheet.file}: the subtitle must stop shouting`);
    assert.equal(props.phoenixFeedState, "ok", `${sheet.file}: the stored state must return to ok`);

    // And a healthy sheet must never be repainted at all.
    const quiet = fakeSheet("Requests", `Everything, live — ${sheet.stampWord} 2026-08-24 03:00:00 (Cairo)`, 43);
    const quietTabs = new Map<string, unknown>([["Requests", quiet], ["Direct Orders", quiet], ["Executive Summary", quiet]]);
    const quietProps: Record<string, string> = {};
    const quietScript = loadScript(source, quietTabs, quietProps);
    quietScript.markFeedFresh({ getSheetByName: (name: string) => quietTabs.get(name) ?? null }, "2026-08-24 03:00:00");
    assert.equal(quiet.writes.length, 0, `${sheet.file}: a healthy refresh must not repaint anything`);
    assert.equal(
      quietProps.phoenixLastGoodStamp,
      "2026-08-24 03:00:00",
      `${sheet.file}: a healthy refresh must still record when the data was last good, or a later banner cannot say when it froze`,
    );
  }
}
