import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveSyncablePeriods, selectUnpublishedPeriods } from "../src/lib/sales/territory/scheduled-sync.ts";

/**
 * THE SYNC BUTTON CARRIES THE SAME PUBLISHED-MONTH GUARD AS THE NIGHTLY JOB.
 *
 * WHY THIS EXISTS. `runScheduledTerritorySync` withholds every period with a published closing
 * before it re-stamps anything — its own header calls that "the entire safety guarantee". The
 * Territory Drilldown's Sync button did not: it built the window with `computeSyncPeriods` and
 * handed it straight to `syncTerritoryData`, published months and all. The page renders the panel
 * for every drilldown role, so roughly 70 sales users could press it.
 *
 * Nothing was corrupted, because `trg_lock_guard_upd` on `source_of_sales_import_rows` raises on a
 * locked closing and rolls the transaction back. But the lock and this guard are NOT the same rule
 * and one must never be trusted to stand in for the other: `monthly_closing_locks` is a switch the
 * owner toggles (all six lines were unlocked for a day in September 2026), while
 * `monthly_closing_publications` is permanent. An unlocked published month passes the trigger and
 * would be re-stamped underneath a closing that has already been sent.
 *
 * The visible cost of the gap was the opposite one: one RPC call carries every period in a single
 * transaction, so the trigger's rollback killed the OPEN months in the same window too — the
 * button had simply failed for every user since the locks went on.
 */

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** The body of a top-level function, up to the next top-level declaration. Line-based on purpose:
 *  a fixed byte window false-fails as soon as anything above it shifts. */
function functionBody(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const declaration = /^(export )?(async )?function [A-Za-z0-9_]+/;
  const start = lines.findIndex((line) => new RegExp(`^(export )?(async )?function ${name}\\b`).test(line));
  assert.notEqual(start, -1, `${name} must exist in the territory sync route`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (declaration.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function runTerritorySyncButtonPublishedGuardTests() {
  const route = readSource("../app/api/employee-portals/territory-drilldown/sync/route.ts");
  const post = functionBody(route, "POST");

  // 1. One definition, shared. The button must reach the guard through the same exported helper
  //    the nightly job uses — a second copy of the filter here is free to drift out of step with
  //    the one in scheduled-sync.ts, and drift is invisible until a published month moves.
  assert.equal(
    typeof resolveSyncablePeriods,
    "function",
    "resolveSyncablePeriods must be exported from scheduled-sync.ts as the one definition of the guard",
  );
  assert.ok(
    /import\s*\{\s*resolveSyncablePeriods\s*\}\s*from\s*"@\/lib\/sales\/territory\/scheduled-sync"/.test(route),
    "the Sync route must import resolveSyncablePeriods from scheduled-sync — that module IS the published-month guard",
  );
  assert.ok(
    post.includes("resolveSyncablePeriods("),
    "the Sync route's POST must resolve its periods through resolveSyncablePeriods",
  );

  // 2. The bypass itself. Calling computeSyncPeriods in this route is exactly what the defect was:
  //    it produces the raw trailing window with every published month still in it.
  assert.ok(
    !post.includes("computeSyncPeriods("),
    "the Sync route must not build its own window with computeSyncPeriods — that is the unguarded path this test exists to catch",
  );

  // 3. The re-stamp receives the FILTERED list, and receives it after the filter has run.
  assert.ok(
    /periods:\s*syncablePeriods/.test(post),
    "syncTerritoryData must receive the syncable periods, never the unfiltered window",
  );
  const filterAt = post.indexOf("resolveSyncablePeriods(");
  const syncAt = post.indexOf("syncTerritoryData(");
  assert.notEqual(syncAt, -1, "the Sync route must actually call syncTerritoryData");
  assert.ok(filterAt < syncAt, "the published-period filter must run BEFORE the re-stamp, not after it");

  // 4. An empty syncable set must short-circuit and return BEFORE the re-stamp. phx_sync_sos_run
  //    treats an absent period list as EVERY period, so passing an empty array is the worst
  //    possible failure: it would re-stamp precisely the published months this guard protects.
  assert.ok(
    /syncablePeriods\.length === 0/.test(post),
    "the Sync route must short-circuit on an empty syncable set instead of calling the re-stamp",
  );
  const shortCircuitAt = post.indexOf("syncablePeriods.length === 0");
  assert.ok(
    shortCircuitAt < syncAt,
    "the empty-set short-circuit must come before the syncTerritoryData call, or it guards nothing",
  );

  // 5. A withheld month is never silent. The operator pressed a button; if a month was left alone
  //    the response has to say which one, or the guard reads as a broken button.
  assert.ok(
    post.includes("publishedPeriodsSkipped"),
    "the Sync route must report which periods it withheld",
  );
  const panel = readSource("../src/components/sales/territory/territory-sync-panel.tsx");
  assert.ok(
    panel.includes("publishedPeriodsSkipped") && panel.includes("setNotice("),
    "the Sync panel must surface the server's message when a period was withheld — a skipped month must not look like nothing happening",
  );

  // 6. The filter itself still does what the button now depends on. Duplicated deliberately from
  //    the scheduled-sync test: this file must fail on its own if the shared helper stops
  //    withholding, rather than pointing at a test somebody could delete with the cron job.
  const window = ["2026-06", "2026-07", "2026-08", "2026-09"];
  assert.deepEqual(
    selectUnpublishedPeriods(window, ["2026-07", "2026-08"]),
    ["2026-06", "2026-09"],
    "a published period is withheld from the button's window exactly as it is from the cron's",
  );
  assert.deepEqual(
    selectUnpublishedPeriods(window, window),
    [],
    "a fully published window leaves the button nothing to sync — which is what the short-circuit above catches",
  );
}
