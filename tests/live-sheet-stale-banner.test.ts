import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The Google Apps Script sheets in docs/ are the owner's live Direct Orders, Marketing Request and
// CV Lifecycle reports. They fetch a Phoenix share-link feed on a timer and, by deliberate design,
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
//
// The per-sheet fields below exist because the sheets are not clones: they have different tabs,
// different script-property names and different palettes. Everything the suite ASSERTS is
// identical for all three — what varies is only the vocabulary needed to drive each file. Adding a
// field to describe a sheet is fine; adding one that lets a sheet opt out of an assertion is not.
const SHEETS = [
  {
    file: "../docs/direct-orders-live-sheet.gs",
    // `e` is the time-driven trigger's event; the night pacing reads it (tests/live-sheet-night-pacing).
    refresh: "function refreshDirectOrders(e)",
    stampWord: "updated",
    // Every early return in the refresh: no token, unreachable, non-200, empty payload.
    minFailurePaths: 4,
    liveTabs: ["Requests", "Direct Orders", "Executive Summary"],
    fixedTab: "Cover",
    liveColumns: 43,
    stateKey: "phoenixFeedState",
    lastGoodKey: "phoenixLastGoodStamp",
    staleBg: "#B91C1C",
    freshBg: "#000000",
  },
  {
    file: "../docs/marketing-request-live-sheet.gs",
    refresh: "function refreshMarketingRequests(e)",
    stampWord: "refreshed",
    // As above plus an unparseable payload, which this sheet handles separately.
    minFailurePaths: 5,
    liveTabs: ["Requests", "Direct Orders", "Executive Summary"],
    fixedTab: "Cover",
    liveColumns: 43,
    stateKey: "phoenixFeedState",
    lastGoodKey: "phoenixLastGoodStamp",
    staleBg: "#B91C1C",
    freshBg: "#000000",
  },
  {
    // Added 2026-09-04 with the sheet itself. Its first version THREW on every failure, which in a
    // time-driven trigger is the silent freeze this whole suite exists to catch — it shipped with
    // the hole already in it, three weeks after the hole was found and fixed in the other two.
    file: "../docs/cv-lifecycle-live-sheet.gs",
    refresh: "function refreshCvLifecycle()",
    // This one takes a script lock and hands the actual work to an inner function, so the failure
    // paths live THERE. Naming it keeps them inside the scan: without this the suite reads only the
    // five-line lock wrapper, finds zero announced paths, and would have to be weakened to pass.
    delegatesTo: "function refreshCvLifecycleLocked_()",
    stampWord: "refreshed",
    // No FEED_URL, unreachable, non-200, unparseable, and a payload carrying no CV rows.
    minFailurePaths: 5,
    // This sheet has no separate cover tab, so its own table tab plays the part: a subtitle that
    // is not a live stamp must survive whichever tab it sits on.
    liveTabs: ["Summary", "Daily Dashboard"],
    fixedTab: "CV Lifecycle",
    liveColumns: 26,
    // Its own property names, so two sheets open in one browser cannot read each other's state.
    stateKey: "phoenixCvFeedState",
    lastGoodKey: "phoenixCvLastGoodStamp",
    staleBg: "#b91c1c",
    // Black, like the other two. This was #ffffff until the v10 layout: row 2 is the LOWER half
    // of the masthead, so restoring it to white painted a white stripe through the middle of the
    // black band — on the one run that is supposed to signal everything is fine again.
    // markFeedFresh restores whatever titleBand_ painted, so what this records is BLACK.
    freshBg: "#000000",
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
 * The lines between a `return;` and the `{` that opens the block it sits in.
 *
 * This used to be a flat five-line window, and that window reached PAST the block into whatever
 * came before it. Every bail-out here is four or five lines long, so the markFeedStale of the
 * PREVIOUS failure path landed inside the next one's lookback and announced it by accident: a
 * bare `return;` added under a fresh `if (...) {` directly below an announced path was invisible
 * to this suite. Reading only as far back as the block opener is what makes the check local to
 * the path it is judging.
 */
function guardBody(lines: string[], returnIndex: number) {
  const out: string[] = [];
  for (let i = returnIndex - 1; i >= 0; i -= 1) {
    out.unshift(lines[i]);
    if (/\{\s*$/.test(lines[i])) break;
  }
  return out.join("\n");
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
    // The refresh may delegate to a locked inner function; both halves are the refresh, and
    // scanning only the wrapper would find zero announced failure paths in a correct file.
    // Read as an optional field rather than narrowing with `in`: only one of the three sheets
    // declares it, and whether that yields a union depends on how the literal is inferred.
    const delegatesTo = (sheet as { delegatesTo?: string }).delegatesTo;
    const body = [sheet.refresh, ...(delegatesTo ? [delegatesTo] : [])]
      .map((signature) => refreshBody(source, signature))
      .join("\n");
    const lines = body.split("\n");

    // 1. No silent early return. Every bail-out in the refresh must first say so on the sheet —
    //    this is the actual defect, and it is invisible by nature, so only a check like this
    //    catches it coming back.
    // A refresh that LOST a lock race is the one bail-out that must NOT paint a banner: the
    // winner is doing the work, so announcing 'stale' over a sheet that is about to refresh
    // successfully is a false alarm — and a false alarm teaches him to ignore the only warning
    // this sheet has. Allowed at most once per file and only directly under a failed tryLock,
    // so it stays a named exception rather than a hiding place for the next silent return.
    // The overnight timer tick that skips because the feed was read under an hour ago is the other
    // one (2026-10-31). Nothing failed and the data is as fresh as the pacing intends, so a banner
    // there would be the same false alarm. Same terms: once per file, directly under the pacing
    // check, and the pacing suite (tests/live-sheet-night-pacing.test.ts) proves only a timer tick
    // can take it.
    const silent: string[] = [];
    let announced = 0;
    let lockSkips = 0;
    let nightSkips = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*return;/.test(lines[i])) continue;
      const lookback = guardBody(lines, i);
      if (lookback.includes("markFeedStale(")) announced += 1;
      else if (/tryLock\(/.test(lookback)) lockSkips += 1;
      else if (/nightTimerTickSkips_\(e\)/.test(lookback)) nightSkips += 1;
      else silent.push(lines[i].trim());
    }
    assert.ok(
      lockSkips <= 1,
      `${sheet.file}: only the lock-contention bail-out may return silently — found ${lockSkips}`,
    );
    assert.ok(
      nightSkips <= 1,
      `${sheet.file}: only one overnight pacing skip may return silently — found ${nightSkips}`,
    );
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
    const live = fakeSheet(
      sheet.liveTabs[0],
      `Everything, live — ${sheet.stampWord} 2026-08-05 15:22:00 (Cairo)`,
      sheet.liveColumns,
    );
    const fixedText = "CONFIDENTIAL — internal data, do not forward";
    const fixed = fakeSheet(sheet.fixedTab, fixedText, 2);
    const tabs = new Map<string, unknown>(sheet.liveTabs.map((tab) => [tab, live] as const));
    tabs.set(sheet.fixedTab, fixed);
    const props: Record<string, string> = { [sheet.lastGoodKey]: "2026-08-05 15:22:00" };
    const script = loadScript(source, tabs, props);

    script.markFeedStale("the feed answered HTTP 403 (the share link was revoked or has expired)");
    const banner = String(live.cells.get("2:1"));
    assert.ok(
      banner.startsWith("⚠ STALE"),
      `${sheet.file}: a failed refresh must mark the subtitle stale, got: ${banner}`,
    );
    assert.match(banner, /2026-08-05 15:22:00/, `${sheet.file}: the banner must name when the data froze`);
    assert.match(banner, /HTTP 403/, `${sheet.file}: the banner must name why the last attempt failed`);
    assert.equal(
      live.format.get(`bg:2:1:${sheet.liveColumns}`),
      sheet.staleBg,
      `${sheet.file}: the banner must be visible, not just wordy`,
    );

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
    assert.equal(
      live.format.get(`bg:2:1:${sheet.liveColumns}`),
      sheet.freshBg,
      `${sheet.file}: the band must go back to its ordinary colour`,
    );
    assert.equal(live.format.get("weight:2:1"), "normal", `${sheet.file}: the subtitle must stop shouting`);
    assert.equal(props[sheet.stateKey], "ok", `${sheet.file}: the stored state must return to ok`);

    // And a healthy sheet must never be repainted at all.
    const quiet = fakeSheet(
      sheet.liveTabs[0],
      `Everything, live — ${sheet.stampWord} 2026-08-24 03:00:00 (Cairo)`,
      sheet.liveColumns,
    );
    const quietTabs = new Map<string, unknown>(sheet.liveTabs.map((tab) => [tab, quiet] as const));
    const quietProps: Record<string, string> = {};
    const quietScript = loadScript(source, quietTabs, quietProps);
    quietScript.markFeedFresh({ getSheetByName: (name: string) => quietTabs.get(name) ?? null }, "2026-08-24 03:00:00");
    assert.equal(quiet.writes.length, 0, `${sheet.file}: a healthy refresh must not repaint anything`);
    assert.equal(
      quietProps[sheet.lastGoodKey],
      "2026-08-24 03:00:00",
      `${sheet.file}: a healthy refresh must still record when the data was last good, or a later banner cannot say when it froze`,
    );
  }
}
