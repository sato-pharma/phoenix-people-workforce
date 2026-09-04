import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { findJobSchedule } from "../src/lib/observability/job-schedule.ts";

/**
 * The nightly territory re-stamp must report that it ran at the instant its work COMMITS — not at
 * the end of a reporting tail that a routine deploy can cut.
 *
 * WHY THIS IS THE ASSERTION THAT MATTERS. The job's durable work is one server-side transaction
 * (`phx_sync_sos_run`). Everything after it — the reconciliation read, the cache invalidation, the
 * audit row — is reporting ABOUT work that has already landed. `withDeadMansSwitch` pings at the
 * very end of that tail, and on 2026-09-04 the gap was fatal: the run committed at 03:20:00 Cairo
 * (seven periods in `au.monthly_attribution_rollup_meta` carry that exact `refreshed_at`) and the
 * production deploy of #3035 went live at 03:20:31, replacing the container mid-tail. No audit row
 * was written and no ping was sent, so the heartbeat register alerted "stranded — nothing has
 * reported" every 15 minutes for 14 hours about a run that had done its job correctly.
 *
 * The tail cannot be trusted to finish: the run measured 24.3s on 2026-09-03 against
 * cron-job.org's hard 30s cap, and production deploys land on every merge. So the ORDER is the
 * fix, and the order is what this test pins. A future refactor that moves the ping back to the end
 * of the run — or "tidies" the hook away by restoring the wrapper — reintroduces a false stranded
 * alarm on a healthy night, which is the most expensive kind of monitoring bug: it trains the
 * owner to ignore the one alert that says a job has stopped.
 */

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

export function runTerritoryRestampLivenessTests() {
  const service = readSource("../src/lib/sales/territory/sync.ts");
  const scheduled = readSource("../src/lib/sales/territory/scheduled-sync.ts");
  const route = readSource("../app/api/cron/territory-restamp/route.ts");

  // ------------------------------------------------- the ordering, which IS the fix

  const runAt = service.indexOf('.rpc("phx_sync_sos_run"');
  const hookAt = service.indexOf("await input.onWorkCommitted()");
  const reconAt = service.indexOf('.rpc("phx_sync_sos_reconciliation"');
  const auditAt = service.indexOf("await writeAuditLog(");

  assert.notEqual(runAt, -1, "syncTerritoryData must still call phx_sync_sos_run");
  assert.notEqual(
    hookAt,
    -1,
    "syncTerritoryData must invoke the onWorkCommitted hook — without it the run's liveness "
      + "depends on a ~25s tail that a deploy can cut",
  );
  assert.notEqual(reconAt, -1, "syncTerritoryData must still call phx_sync_sos_reconciliation");
  assert.notEqual(auditAt, -1, "syncTerritoryData must still write its audit row");

  // 1. THE HEADLINE. The commit hook fires BEFORE the reconciliation read and BEFORE the audit
  //    write. This is the whole repair: reporting must not sit behind a tail that can be killed.
  assert.ok(
    hookAt < reconAt,
    "onWorkCommitted must fire BEFORE the reconciliation read — a ping behind the tail is exactly "
      + "what left the 2026-09-04 run reading as stranded for 14 hours after it had committed",
  );
  assert.ok(
    hookAt < auditAt,
    "onWorkCommitted must fire BEFORE the audit write, for the same reason",
  );

  // 2. And NOT before the work commits. A hook moved above the RPC would report success for a
  //    re-stamp that has not happened — a false success is worse than no register at all.
  assert.ok(
    runAt < hookAt,
    "onWorkCommitted must fire AFTER phx_sync_sos_run returns — never claim success for work that "
      + "has not committed",
  );

  // 3. Awaited, not fire-and-forget: an unawaited ping is exactly as orphanable as the tail it
  //    replaces, so the bare-call form must not creep back in.
  assert.ok(
    !/(?<!await\s)\binput\.onWorkCommitted\(\)/.test(service),
    "the onWorkCommitted hook must be awaited — an unawaited promise dies with the container just "
      + "as the tail did",
  );

  // 4. A reporting failure must never fail a committed sync.
  assert.ok(
    /try\s*\{\s*await input\.onWorkCommitted\(\);\s*\}\s*catch/.test(service),
    "the onWorkCommitted call must be wrapped — a broken reporter must not turn a committed "
      + "re-stamp into a failed one",
  );

  // ------------------------------------------------- the hook is actually threaded through

  // 5. The scheduled runner must pass the caller's hook down, or the route's ping never fires.
  assert.ok(
    /onWorkCommitted:\s*options\.onWorkCommitted/.test(scheduled),
    "runScheduledTerritorySync must hand its onWorkCommitted option to syncTerritoryData",
  );

  // ------------------------------------------------- the route reports it

  // 6. The explicit ping, not the wrapper. The wrapper reports only at the end of the run, which
  //    is the shape this whole test exists to prevent.
  assert.match(
    route,
    /import \{ pingDeadMansSwitch \} from "@\/lib\/observability\/dead-mans-switch";/,
    "the territory re-stamp route must ping the dead-man's switch directly",
  );
  assert.ok(
    !route.includes("withDeadMansSwitch("),
    "the route must NOT use withDeadMansSwitch: it pings at the END of the run, leaving the ~25s "
      + "reporting tail between the commit and the ping",
  );

  // 7. The route hands its ping in as the commit hook.
  assert.ok(
    route.includes("onWorkCommitted: reportSuccessOnce"),
    "the route must report success through the commit hook, not after the run returns",
  );

  // 8. The skip path commits nothing and so never fires the hook — a night on which every period
  //    is published is a healthy run, and must still report.
  assert.ok(
    route.includes('pingDeadMansSwitch(JOB_SLUG, "success")'),
    "the route must still report success on the skip path, which fires no commit hook",
  );

  // 9. A failure in the tail must still be reported. recordJobHeartbeat writes only the timestamp
  //    for the outcome it is given, so last_success_at survives and the register says both things.
  assert.match(
    route,
    /pingDeadMansSwitch\(JOB_SLUG, "fail"/,
    "the route must still report failure — reporting success early must not silence a real fault",
  );

  // 10. The slug must be the one the register actually watches. A typo here reports a job nobody
  //     is asking about while the real slug goes on reading as stranded.
  const slug = /const JOB_SLUG = "([^"]+)"/.exec(route)?.[1];
  assert.equal(slug, "phoenix-territory-restamp", "the route must ping under its own declared slug");
  assert.ok(
    findJobSchedule("phoenix-territory-restamp"),
    "the slug the route pings must be declared in JOB_SCHEDULES, or the sweeper never judges it",
  );
}
