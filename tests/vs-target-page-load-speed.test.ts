import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { MonthlyAttributionRow } from "../src/lib/sales/monthly-attribution.ts";
import { newestPublishedPeriod, pickLandingPeriod } from "../src/lib/sales/vs-target.ts";
import {
  buildChannelSplit,
  channelSplitCacheKeyParts,
  channelSplitCellsOf,
} from "../src/lib/sales/vs-target-page.ts";
import type { VsTargetBound } from "../src/lib/sales/vs-target-scope.ts";
import { stripComments } from "./support/comment-strip.ts";

// Sales vs Target — the whole page load (owner, 2026-10-31: "whole page load").
//
// Measured on the page's own reads: the Direct/Indirect channel split's attribution pass took
// 0.64–1.2 s on EVERY load and ran AFTER every other read, because with no month in the request it
// waited for the range to pick the landing month. And the full employee-name read spiked to 4.5 s
// and 7.0 s — the two slowest loads of the run. Three things fixed it, each pinned here:
//   1. the channel split is cut to the five fields it reads and cached on the achievement token;
//   2. it starts as soon as the publication keys land, for the month the page will land on;
//   3. the employee-name map is a one-minute single-flight memo.

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => stripComments(readFileSync(new URL(path, ROOT), "utf8"));

function row(partial: Partial<MonthlyAttributionRow>): MonthlyAttributionRow {
  return {
    channel: "indirect",
    lineCode: "cns",
    areaCode: "C1",
    repHrId: "R-1",
    salesValue: 0,
    mapped: true,
    unmappedReason: null,
    ...partial,
  } as MonthlyAttributionRow;
}

/** The pre-cache buildChannelSplit, word for word, over the FULL attribution rows — the reference. */
function referenceSplit(rows: MonthlyAttributionRow[], bound: VsTargetBound) {
  if (rows.length === 0) return null;
  let direct = 0;
  let indirect = 0;
  for (const r of rows) {
    if (!r.mapped) continue;
    if (!referenceInBound(r, bound)) continue;
    if (r.channel === "direct") direct += r.salesValue;
    else if (r.channel === "indirect") indirect += r.salesValue;
  }
  return direct === 0 && indirect === 0 ? null : { direct, indirect };
}

function referenceInBound(r: MonthlyAttributionRow, bound: VsTargetBound): boolean {
  switch (bound.kind) {
    case "company":
      return true;
    case "none":
      return false;
    case "self":
      return String(r.repHrId ?? "").trim().toLowerCase() === bound.hrId;
    case "line":
      return r.lineCode != null && bound.lineCodes.has(r.lineCode);
    case "areas": {
      if (bound.lineCodes && (r.lineCode == null || !bound.lineCodes.has(r.lineCode))) return false;
      const areaCode = String(r.areaCode ?? "").trim().toUpperCase();
      return Boolean(areaCode) && bound.areaCodes.has(areaCode);
    }
  }
}

export async function runVsTargetPageLoadSpeedTests(): Promise<void> {
  // ── 1. The cut-down cells give the SAME split as the full rows, for every kind of viewer ──────────
  const rows: MonthlyAttributionRow[] = [
    row({ channel: "indirect", salesValue: 1000.1 }),
    row({ channel: "direct", salesValue: 250.25 }),
    row({ channel: "indirect", lineCode: "pedia", areaCode: "P2", repHrId: "R-2", salesValue: 333.3 }),
    row({ channel: "direct", lineCode: "pedia", areaCode: "p2", repHrId: "r-2", salesValue: 77.7 }),
    // Never counted by the split: unmapped rows, and the 'unmapped' channel.
    row({ channel: "indirect", mapped: false, salesValue: 9999 }),
    row({ channel: "unmapped", mapped: true, salesValue: 5555 }),
    row({ channel: "direct", lineCode: null, areaCode: null, repHrId: null, salesValue: 40 }),
  ];
  const bounds: VsTargetBound[] = [
    { kind: "company" },
    { kind: "line", lineCodes: new Set(["pedia"]) },
    { kind: "areas", areaCodes: new Set(["P2"]), lineCodes: new Set(["pedia"]) },
    { kind: "areas", areaCodes: new Set(["C1"]), lineCodes: null },
    { kind: "self", hrId: "r-2" },
  ] as VsTargetBound[];
  const cells = channelSplitCellsOf(rows);
  assert.equal(cells.length, 5, "only mapped direct and indirect rows are kept — the only rows the split ever added");
  for (const bound of bounds) {
    assert.deepEqual(
      buildChannelSplit(cells, bound),
      referenceSplit(rows, bound),
      `🔴 the cached cells must split exactly as the full rows did (bound ${bound.kind})`,
    );
  }
  // An empty or failed month still hides the panel, as before.
  assert.equal(buildChannelSplit(channelSplitCellsOf([]), { kind: "company" } as VsTargetBound), null);
  assert.equal(
    buildChannelSplit(channelSplitCellsOf([row({ mapped: false, salesValue: 10 })]), { kind: "company" } as VsTargetBound),
    null,
    "a month with no mapped sale still hides the panel",
  );

  // ── 2. The cache key carries the period AND the achievement freshness token ─────────────────────
  const key = channelSplitCacheKeyParts("2026-09", "tok-A");
  assert.ok(key.includes("2026-09") && key.includes("tok-A"), "🔴 the key must carry the period and the token");
  assert.notDeepEqual(key, channelSplitCacheKeyParts("2026-09", "tok-B"), "a new token is a new entry");
  assert.notDeepEqual(key, channelSplitCacheKeyParts("2026-08", "tok-A"), "another month is another entry");

  const page = read("src/lib/sales/vs-target-page.ts");
  const loader = page.slice(page.indexOf("export async function loadChannelSplitCells"));
  assert.match(loader, /loadAchievementCacheStamp\(\)/, "keyed on the same token as the achievement months");
  assert.match(loader, /if \(!token\) return channelSplitCellsOf\(await loadMonthlyAttribution\(period\)\)/, "a null token reads live, never a stale entry");
  assert.match(loader, /tags: \[SALES_ACHIEVEMENT_STAMPED_CACHE_TAG\]/, "a price edit expires it with the totals beside it");
  assert.match(loader, /shareTokenKeyedRead\(/, "concurrent misses share one read");

  // ── 3. The pass starts EARLY — on the publication keys, before the range — not after it ─────────
  const builder = page.slice(
    page.indexOf("export async function buildVsTargetDashboard"),
    page.indexOf("export function buildChannelSplit"),
  );
  const earlyStart = builder.indexOf("const earlyChannelSplit");
  const rangeAwait = builder.indexOf("await Promise.all([");
  assert.ok(earlyStart > 0 && rangeAwait > 0, "the builder still has both landmarks");
  assert.ok(earlyStart < rangeAwait, "🔴 the channel split must start before the page waits for the range");
  assert.match(
    builder,
    /publishedKeysLoad\.then\(\(keys\) => newestPublishedPeriod\(keys\) \?\? current\)/,
    "🔴 with no month in the request it guesses the newest published month from the keys alone",
  );
  assert.doesNotMatch(builder, /loadMonthlyAttribution\(/, "the builder never reads the full attribution itself");
  assert.match(
    builder,
    /early\.period === period\s*\?\s*early\.cells\s*:\s*await loadChannelSplitCells\(period\)/,
    "a wrong guess falls back to reading the landing month",
  );

  // The guess is the very fallback pickLandingPeriod uses — one rule, not two.
  const keys = new Set(["cns|2026-08", "pedia|2026-09", "anti_infective|2026-07"]);
  assert.equal(newestPublishedPeriod(keys), "2026-09");
  assert.equal(newestPublishedPeriod(new Set()), null);
  assert.equal(pickLandingPeriod([], keys, "2026-10"), "2026-09", "with no sales in scope it lands on the newest published month");
  assert.equal(pickLandingPeriod([], new Set(), "2026-10"), "2026-10");

  // ── 4. The employee-name map is a one-minute single-flight memo, and each caller gets a copy ────
  const targets = read("src/lib/sales/monthly-targets.ts");
  const ttl = /export const EMPLOYEE_NAME_MAP_TTL_MS = ([0-9_]+);/.exec(targets);
  assert.ok(ttl, "the name map has a TTL constant");
  assert.ok(Number(ttl[1].replace(/_/g, "")) <= 60_000, "names only — never held longer than a minute");
  const nameLoader = targets.slice(
    targets.indexOf("export async function loadEmployeeNameMap"),
    targets.indexOf("async function loadEmployeeNameMapLive"),
  );
  assert.match(
    nameLoader,
    /memoInFlight\(employeeNameMapMemo, "all", EMPLOYEE_NAME_MAP_TTL_MS, 1, loadEmployeeNameMapLive\)/,
    "🔴 the name map must go through the shared single-flight memo",
  );
  assert.match(nameLoader, /return new Map\(shared\)/, "each caller gets its own copy of the map");
}
