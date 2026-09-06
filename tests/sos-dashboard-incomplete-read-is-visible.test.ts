import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildInsights } from "../src/lib/sales/sos-dashboard.ts";

/**
 * `getSosDashboard` collects every aggregate that failed to load into `failedRpcs` and publishes it
 * as `incompleteReason`, documented in the type as "the UI's error signal". **No component ever read
 * it** — `git grep incompleteReason` outside sos-dashboard.ts returns nothing. So a timed-out RPC
 * rendered as clean zeros, and a reader had no way to tell "no sales this month" from "this did not
 * load". On a sales dashboard those two readings lead to opposite decisions.
 *
 * The signal now reaches the Insights strip, which BOTH the admin and portal dashboards render.
 */

const SRC = readFileSync(new URL("../src/lib/sales/sos-dashboard.ts", import.meta.url), "utf8");

const emptySummary = {
  totalValue: 0, totalUnits: 0, avgPricePerUnit: 0, distributorCount: 0, productCount: 0,
  customerCount: 0, directValue: 0, distributorValue: 0, directShare: 0,
  areasReached: 0, totalAreas: 0, bricksReached: 0, totalBricks: 0,
} as unknown as Parameters<typeof buildInsights>[0]["summary"];

const base = {
  byDistributor: [], byRegion: [], byArea: [], byProduct: [],
  summary: emptySummary, customerTop10Share: 0, whiteSpaceAreas: [], singleRegion: false,
};

export function runSosDashboardIncompleteReadIsVisibleTests() {
  // 1. The headline: a failed aggregate must reach the screen, and must be the FIRST thing said —
  //    every number below it is partial, so nothing beneath should be read before this is.
  const failed = buildInsights({ ...base, incompleteReason: ["phx_exec_customers", "phx_exec_bricks"] });
  assert.ok(failed.length > 0, "a failed aggregate must produce at least one insight");
  assert.equal(failed[0].tone, "danger", "an incomplete read is a danger, not a neutral note");
  assert.match(
    failed[0].text,
    /INCOMPLETE/,
    "the reader must be told the view is incomplete, in terms they cannot miss",
  );
  assert.match(
    failed[0].text,
    /phx_exec_customers/,
    "name the sources that failed — 'something failed' is not actionable",
  );
  assert.match(
    failed[0].text,
    /never as a fall in sales/,
    "say explicitly that this is missing data, because zeros on a sales dashboard read as a collapse",
  );

  // 2. A healthy read says nothing about completeness — no permanent scary banner.
  const healthy = buildInsights({ ...base, incompleteReason: [] });
  assert.ok(
    !healthy.some((i) => /INCOMPLETE/.test(i.text)),
    "a healthy load must not claim to be incomplete",
  );

  // 3. The field still exists on the payload AND is now consumed. Publishing it while nobody reads
  //    it is the exact defect: the signal existed and could not reach anyone.
  assert.ok(SRC.includes("incompleteReason: failedRpcs"), "the payload must still publish the reason");
  assert.ok(
    SRC.includes("incompleteReason: input.incompleteReason") || SRC.includes("input.incompleteReason.length > 0"),
    "buildInsights must actually CONSUME incompleteReason, not merely accept it",
  );
}
