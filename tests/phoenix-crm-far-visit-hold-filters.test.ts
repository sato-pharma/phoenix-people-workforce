import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_HOLD_SORT,
  FAR_VISIT_HOLDS_PATH,
  distanceBandOf,
  farVisitHoldFilterOptions,
  farVisitHoldsHref,
  filterFarVisitHolds,
  holdFilterNarrows,
  parseFarVisitHoldFilter,
  type FilterableHold,
} from "../src/lib/phoenix-crm/far-visit-hold-filter-rules.ts";

/**
 * The advanced filters on Visits held for SFE (owner, 23 Nov 2026: "in the held visits make me advanced filters
 * top to be able to filter instead of passing by all visits to find what I want"). 96 held visits from 18 reps
 * were one long list; the filter narrows and orders them, and never changes who may open the page.
 */

function hold(overrides: Partial<FilterableHold> & { id: string }): FilterableHold & { id: string } {
  return {
    status: "sfe_pending",
    basis: "before_place",
    repName: "Esraa Ibrahim",
    customerName: "Dr. Mona Adel",
    territory: "Nasr City 2",
    visitDate: "2026-11-16",
    heldAt: "2026-11-16T09:00:00.000Z",
    distanceMeters: 800,
    ...overrides,
  };
}

const HOLDS = [
  hold({ id: "a", heldAt: "2026-11-16T09:00:00.000Z", distanceMeters: 320 }),
  hold({ id: "b", status: "approved", heldAt: "2026-11-20T09:00:00.000Z", distanceMeters: 2400 }),
  hold({ id: "c", repName: "Momen Fathy", customerName: "د. دعاء أحمد", territory: "Maadi 1", basis: "stuck", visitDate: "2026-11-10", heldAt: "2026-11-10T08:00:00.000Z", distanceMeters: 8300 }),
  hold({ id: "d", repName: "ahmed Samir", status: "refused", visitDate: "2026-11-21", heldAt: "2026-11-21T10:00:00.000Z", distanceMeters: null }),
  hold({ id: "e", repName: "Momen Fathy", territory: "Maadi 1", visitDate: "2026-11-22", heldAt: "2026-11-22T07:00:00.000Z", distanceMeters: 999 }),
];

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).join(",");

export function runPhoenixCrmFarVisitHoldFiltersTests() {
  // ── Reading the address ─────────────────────────────────────────────────────────────────────────
  {
    const empty = parseFarVisitHoldFilter({});
    assert.equal(empty.sort, DEFAULT_HOLD_SORT, "no choice keeps the page's own order");
    assert.equal(holdFilterNarrows(empty), false, "and narrows nothing");
    assert.equal(ids(filterFarVisitHolds(HOLDS, empty)), "e,a,c,d,b", "waiting first, newest held first — the page's order before the filter");

    const junk = parseFarVisitHoldFilter({ status: "pending", basis: "far", distance: "10km", sort: "random", from: "2026-02-30", to: "16/11/2026" });
    assert.deepEqual(
      [junk.status, junk.basis, junk.distance, junk.from, junk.to, junk.sort],
      [null, null, null, null, null, DEFAULT_HOLD_SORT],
      "a value that does not parse is simply not applied — never a 500, never an empty page",
    );

    const backwards = parseFarVisitHoldFilter({ from: "2026-11-20", to: "2026-11-15" });
    assert.deepEqual([backwards.from, backwards.to], ["2026-11-15", "2026-11-20"], "days typed the wrong way round are read as the range they mean");

    assert.equal(parseFarVisitHoldFilter({ q: ["  Esraa ", "x"] }).q, "Esraa", "a repeated value reads its first, trimmed");
    assert.equal(parseFarVisitHoldFilter({ q: "x".repeat(500) }).q?.length, 200, "a search is cut at 200 characters");
    assert.equal(holdFilterNarrows(parseFarVisitHoldFilter({ sort: "farthest" })), false, "the order alone narrows nothing");
  }

  // ── Each filter ─────────────────────────────────────────────────────────────────────────────────
  {
    const by = (params: Record<string, string>) => ids(filterFarVisitHolds(HOLDS, parseFarVisitHoldFilter(params)));
    assert.equal(by({ status: "waiting" }), "e,a,c", "Waiting for SFE is the sfe_pending rows only");
    assert.equal(by({ status: "approved" }), "b");
    assert.equal(by({ status: "refused" }), "d");
    assert.equal(by({ basis: "stuck" }), "c", "why it was held");
    assert.equal(by({ rep: "Momen Fathy" }), "e,c", "one rep's visits");
    assert.equal(by({ territory: "Maadi 1" }), "e,c", "one territory's visits");
    assert.equal(by({ from: "2026-11-16", to: "2026-11-21" }), "a,d,b", "visit days, both ends counted");
    assert.equal(by({ to: "2026-11-10" }), "c", "an open-ended range");
    assert.equal(by({ distance: "under_500" }), "a");
    assert.equal(by({ distance: "500_1000" }), "e", "999 m is under a kilometre");
    assert.equal(by({ distance: "1_5_km" }), "b");
    assert.equal(by({ distance: "over_5_km" }), "c");
    assert.equal(distanceBandOf(null), null, "🔴 an unmeasured visit falls in no band — never guessed near");
    assert.equal(distanceBandOf(1000), "1_5_km", "a kilometre exactly is the next band");
    assert.equal(by({ rep: "Momen Fathy", status: "waiting", basis: "before_place" }), "e", "filters combine");
  }

  // ── The name search ─────────────────────────────────────────────────────────────────────────────
  {
    const find = (q: string) => ids(filterFarVisitHolds(HOLDS, parseFarVisitHoldFilter({ q })));
    assert.equal(find("AHMED"), "d", "English is found whatever its case");
    assert.equal(find("دعاء احمد"), "c", "🔴 Arabic is found whatever its hamza — أحمد is found as احمد");
    assert.equal(find("momen maadi"), "e,c", "every word must be found, in the rep, the customer or the territory");
    assert.equal(find("momen nasr"), "", "and a word found nowhere keeps nothing");
  }

  // ── The order ───────────────────────────────────────────────────────────────────────────────────
  {
    const sorted = (sort: string) => ids(filterFarVisitHolds(HOLDS, parseFarVisitHoldFilter({ sort })));
    assert.equal(sorted("visit_newest"), "e,d,b,a,c");
    assert.equal(sorted("visit_oldest"), "c,a,b,d,e");
    assert.equal(sorted("farthest"), "c,b,e,a,d", "farthest first, the unmeasured one last");
    assert.equal(sorted("rep"), "d,b,a,e,c", "rep A to Z whatever the case, newest visit first within a rep");
    const before = ids(HOLDS);
    filterFarVisitHolds(HOLDS, parseFarVisitHoldFilter({ sort: "farthest" }));
    assert.equal(ids(HOLDS), before, "the page's own list is never re-ordered in place");
  }

  // ── The choices offered, and the address ─────────────────────────────────────────────────────────
  {
    const options = farVisitHoldFilterOptions(HOLDS);
    assert.deepEqual(options.reps, ["ahmed Samir", "Esraa Ibrahim", "Momen Fathy"], "each rep once, A to Z");
    assert.deepEqual(options.territories, ["Maadi 1", "Nasr City 2"]);
    assert.equal(farVisitHoldsHref(parseFarVisitHoldFilter({})), FAR_VISIT_HOLDS_PATH, "no choice, no query");
    const href = farVisitHoldsHref(parseFarVisitHoldFilter({ rep: "Momen Fathy", sort: "farthest", status: "waiting" }));
    assert.equal(href, `${FAR_VISIT_HOLDS_PATH}?status=waiting&rep=Momen+Fathy&sort=farthest`);
    const again = parseFarVisitHoldFilter(Object.fromEntries(new URL(href, "https://x").searchParams));
    assert.deepEqual([again.status, again.rep, again.sort], ["waiting", "Momen Fathy", "farthest"], "the address reads back as the same choice");
  }

  // ── The page ────────────────────────────────────────────────────────────────────────────────────
  {
    const page = readFileSync("app/(admin)/admin/phoenix-crm/far-visit-holds/page.tsx", "utf8");
    assert.match(page, /const shown = filterFarVisitHolds\(holds, filter\);/, "the page narrows its own rows through the rule");
    assert.equal((page.match(/\{shown\.map\(\(entry\) => \(/g) ?? []).length, 2, "🔴 the desktop table AND the phone cards both draw the filtered rows");
    assert.doesNotMatch(page, /\[\.\.\.waiting, \.\.\.decided\]\.map/, "no list still draws the whole queue");
    assert.match(page, /value=\{waiting\.length\}/, "the cards still count the whole queue");
    assert.match(page, /<form action=\{FAR_VISIT_HOLDS_PATH\} method="get"/, "a plain GET form — the choice lives in the address");
    assert.ok(page.indexOf('canAccess(access, "phoenix_crm", "read")') < page.indexOf("parseFarVisitHoldFilter(params)"), "🔴 the gate is asked before anything the address says");
    assert.match(page, /No held visit matches this choice\./, "an empty result says so, never a blank page");
  }
}
