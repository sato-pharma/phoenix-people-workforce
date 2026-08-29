import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SCHEDULED_TERRITORY_SYNC_ACTOR,
  selectUnpublishedPeriods,
} from "../src/lib/sales/territory/scheduled-sync.ts";

/**
 * The nightly territory re-stamp must never touch a published closing.
 *
 * WHY THIS IS THE ASSERTION THAT MATTERS. Publishing a monthly closing does NOT freeze its
 * figures — `monthly_closing_publications.snapshot_units` was NULL on every published row when this
 * job was written — so re-stamping a published period rewrites numbers underneath a closing that
 * has already been sent to every sales and product manager. There is also a standing instruction
 * that Pedia and Anti-Infective July must not be re-stamped, and July is the published period. A
 * scheduled job that ignored publication state would have done exactly that on its first run, at
 * 02:00, silently: 260 drifted rows were measured in production on 2026-08-29 and every one of them
 * sat in 2026-07.
 *
 * So `selectUnpublishedPeriods` is not a convenience — it is the entire safety property of the job,
 * which is why it is a pure function tested directly rather than a filter buried in a DB call.
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
  assert.notEqual(start, -1, `${name} must exist in the scheduled territory sync`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (declaration.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function runTerritoryScheduledSyncTests() {
  const TWELVE = [
    "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02",
    "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
  ];

  // ---------------------------------------------------------------- the safety property

  // 1. THE HEADLINE. A published period is withheld from the re-stamp. This is the production
  //    shape as measured 2026-08-29: 2026-07 published on all three lines, everything else open.
  const eligible = selectUnpublishedPeriods(TWELVE, ["2026-07"]);
  assert.ok(
    !eligible.includes("2026-07"),
    "a published period must never be handed to the re-stamp — publishing does not freeze a closing's figures",
  );

  // 2. And it withholds ONLY that period; withholding everything would be 'safe' and useless.
  assert.deepEqual(
    eligible,
    ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-08"],
    "every open period must still be synced, in window order",
  );

  // 3. Several published periods are all withheld.
  assert.deepEqual(
    selectUnpublishedPeriods(TWELVE, ["2026-06", "2026-07", "2025-09"]),
    ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-08"],
    "every published period is withheld, not just the newest",
  );

  // 4. Nothing published → the whole window is eligible.
  assert.deepEqual(selectUnpublishedPeriods(TWELVE, []), TWELVE, "an empty publication set withholds nothing");

  // 5. Everything published → nothing is eligible. The caller must then skip the RPC entirely
  //    rather than call it with an empty array (which `phx_sync_sos_run` would read as "all periods").
  assert.deepEqual(selectUnpublishedPeriods(TWELVE, TWELVE), [], "a fully published window leaves nothing to sync");

  // 6. Whitespace must not defeat the guard. A padded ' 2026-07 ' coming back from the database
  //    would otherwise miss the Set lookup and re-stamp a published month.
  assert.ok(
    !selectUnpublishedPeriods(TWELVE, [" 2026-07 "]).includes("2026-07"),
    "a whitespace-padded published period must still be withheld",
  );

  // 7. Empty/blank entries are ignored rather than withholding a real period by accident.
  assert.deepEqual(selectUnpublishedPeriods(["2026-08"], ["", "   "]), ["2026-08"], "blank publication rows withhold nothing");

  // ---------------------------------------------------------------- the guard is actually wired

  const source = readSource("../src/lib/sales/territory/scheduled-sync.ts");
  const run = functionBody(source, "runScheduledTerritorySync");

  // 8. The guard must be applied by the scheduled runner, not merely exported beside it. Without
  //    this, a future edit could call syncTerritoryData with the raw window and every unit test
  //    above would still pass.
  assert.ok(
    run.includes("selectUnpublishedPeriods("),
    "runScheduledTerritorySync must filter the window through selectUnpublishedPeriods before syncing",
  );
  const filterAt = run.indexOf("selectUnpublishedPeriods(");
  const syncAt = run.indexOf("syncTerritoryData(");
  assert.notEqual(syncAt, -1, "runScheduledTerritorySync must actually call syncTerritoryData");
  assert.ok(filterAt < syncAt, "the published-period filter must run BEFORE the re-stamp, not after it");

  // 9. The re-stamp must be handed the filtered list, never the raw window.
  assert.ok(
    /periods:\s*syncedPeriods/.test(run),
    "syncTerritoryData must receive the filtered periods, never the unfiltered window",
  );

  // 10. Reading the publication list must fail CLOSED. If we cannot prove what is published we
  //     must not re-stamp anything — a swallowed error here silently removes the whole guard.
  const list = functionBody(source, "listPublishedClosingPeriods");
  assert.ok(
    /throw new Error\(/.test(list),
    "listPublishedClosingPeriods must throw when it cannot read publications — it must never fall back to 'nothing is published'",
  );

  // 11. An empty eligible set must short-circuit rather than call the RPC. phx_sync_sos_run treats
  //     a NULL/absent period list as EVERY period, so a careless empty-array call is the worst
  //     possible failure: it would re-stamp precisely the published months this guard exists for.
  assert.ok(
    /syncedPeriods\.length === 0/.test(run),
    "runScheduledTerritorySync must short-circuit on an empty eligible set instead of calling the re-stamp",
  );

  // ---------------------------------------------------------------- it stays silent

  // 12. This job does work; it must not become a notifier. The owner's rule is no extra mail, and
  //     the audit row plus an INFO log are the whole intended trace.
  for (const forbidden of ["sendEmail", "queueEmail", "sendTelegram", "createNotification", "notifyRole"]) {
    assert.ok(
      !source.includes(forbidden),
      `the scheduled territory re-stamp must send nothing — found ${forbidden}`,
    );
  }

  // 13. A scheduled run must be distinguishable from a human pressing Sync in the audit trail.
  assert.ok(
    SCHEDULED_TERRITORY_SYNC_ACTOR.startsWith("system:"),
    "a scheduled run must audit under a system actor, not a person",
  );
  assert.ok(
    run.includes("SCHEDULED_TERRITORY_SYNC_ACTOR"),
    "runScheduledTerritorySync must audit under the scheduled actor",
  );

  // ---------------------------------------------------------------- the route

  const route = readSource("../app/api/cron/territory-restamp/route.ts");
  assert.ok(
    route.includes('from "@/lib/security/cron-auth"'),
    "the cron route must use the shared cron guard, never its own copy of the policy",
  );
  assert.ok(
    route.includes("assertCronAuthorized(request, \"cron/territory-restamp\")"),
    "the cron route must assert authorization before doing any work",
  );

  // 14. The route must delegate to the guarded domain function. Asserted on the IMPORTS, not on a
  //     bare substring: the route's own doc comment legitimately names syncTerritoryData, and a
  //     prose mention is not a bypass. Importing the raw sync module is.
  assert.ok(
    route.includes('from "@/lib/sales/territory/scheduled-sync"'),
    "the cron route must import the guarded scheduled sync",
  );
  assert.ok(
    !/from\s+"@\/lib\/sales\/territory\/sync"/.test(route),
    "the cron route must not import the raw sync — that path skips the published-closing guard",
  );

  // 15. The route must be in the access registry, or it is an unregistered API surface.
  const registry = readSource("../src/lib/security/access-registry.ts");
  assert.ok(
    registry.includes('pattern: "/api/cron/territory-restamp"'),
    "the cron route must be declared in the access registry",
  );
}
