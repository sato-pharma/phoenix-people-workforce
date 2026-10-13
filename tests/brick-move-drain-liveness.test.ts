import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { findJobSchedule } from "../src/lib/observability/job-schedule.ts";
import {
  assessStuckBrickMoveFiles,
  BRICK_MOVE_STUCK_AFTER_MS,
  buildBrickMoveStuckMessage,
} from "../src/lib/sales/master-data/brick-move-stuck-alert.ts";
import {
  assessUnsettledBrickMoveNet,
  buildBrickMoveNetUnsettledMessage,
} from "../src/lib/sales/master-data/brick-move-net-alert.ts";
import {
  SETTLE_PERIODS_PER_RUN,
  settleBrickMoveNet,
  type SettleSupabase,
} from "../src/lib/sales/master-data/brick-move-net-settle.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A brick move must finish draining itself without a human holding a tab open.
 *
 * WHAT WENT WRONG, and what this file therefore refuses to let back in.
 * `sos_relocate_brick` applies a move to the brick master, the customer map and the import rows
 * immediately, and queues the sales files whose TOTALS still need rebuilding in
 * `source_of_sales_brick_move_files`. Until 2026-10-13 the only thing that drained that queue was a
 * poller on one screen — `brick-move-refresh.tsx`, the sole caller of
 * `POST /api/sales/brick-moves/refresh`. There was no cron, no job and no trigger, so closing the
 * Database Mapping tab stopped the rebuild with the move already half-applied, and nothing anywhere
 * said so. The قوص and أبنود moves of 2026-10-12 left 71 files unrebuilt from 13:27 Cairo: for a
 * full day every Qena figure on every screen was pre-move while the mapping under it had changed.
 *
 * Three things keep that closed, and each fails here for its own reason:
 *
 *   1. THE CLOCK EXISTS AND IS WATCHED. A route with no declaration is judged by nobody; a
 *      declaration with no route reads as a job that has stopped. Both halves are asserted.
 *   2. LIVENESS IS REPORTED AT THE FIRST COMMIT, not at the end of the drain. This is the
 *      `/api/cron/territory-restamp` lesson, which cost 14 hours of false "stranded" alarms on
 *      2026-09-04: production deploys on every merge, and a four-minute budget is long enough for a
 *      deploy to replace the container mid-run. A ping behind the run is a ping that is lost on a
 *      healthy run — the most expensive kind of monitoring bug, because it teaches the owner to
 *      ignore the one alert that says a job has died.
 *   3. THE CADENCE IS ONE NUMBER IN TWO FILES. `JOB_SCHEDULES` is what the heartbeat sweep judges
 *      against and `scripts/cronjob-sync.mjs` is what the scheduler is actually built from. Drift
 *      between them means the register calls a job that fires perfectly well late, for ever.
 *
 * Every presence assertion reads COMMENT-STRIPPED source: this file's subject is prose-heavy, and a
 * header sentence naming a call must never satisfy an assertion that the call is still there.
 */

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SLUG = "phoenix-brick-move-drain";

export async function runBrickMoveDrainLivenessTests() {
  const routeRaw = readSource("../app/api/cron/brick-move-drain/route.ts");
  const route = stripComments(routeRaw);
  const drain = stripComments(readSource("../src/lib/sales/master-data/brick-moves.ts"));
  const sync = readSource("../scripts/cronjob-sync.mjs");
  const migration = readSource("../supabase/migrations/20261013130000_sos_fact_rollup_statement_timeout.sql");
  const alert = stripComments(readSource("../src/lib/sales/master-data/brick-move-stuck-alert.ts"));
  const netAlert = stripComments(readSource("../src/lib/sales/master-data/brick-move-net-alert.ts"));

  // ------------------------------------------------- 1. the clock exists, and something watches it

  const declaration = findJobSchedule(SLUG);
  assert.ok(
    declaration,
    `${SLUG} must be declared in JOB_SCHEDULES — a cron route nothing declares is judged by nobody, `
      + "so it can stop firing and no one is told",
  );
  assert.equal(declaration?.kind, "cron");
  assert.equal(
    declaration?.schedule,
    "19,39,59 * * * *",
    "the drain fires every twenty minutes: a brick move must not wait on the next nightly anything",
  );

  const slug = /const JOB_SLUG = "([^"]+)"/.exec(route)?.[1];
  assert.equal(
    slug,
    SLUG,
    "the route must ping under its own declared slug — a typo reports a job nobody asks about while "
      + "the real slug goes on reading as stranded",
  );

  // The route is reachable only behind the cron bearer. Without this it is an unauthenticated
  // endpoint that rebuilds production rollups.
  assert.ok(
    route.includes("assertCronAuthorized(request,"),
    "the drain route must be gated by assertCronAuthorized",
  );

  // ------------------------------------------------- 2. liveness is reported at the FIRST commit

  assert.ok(
    route.includes('import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";'),
    "the drain route must ping the dead-man's switch directly",
  );
  assert.ok(
    !route.includes("withDeadMansSwitch("),
    "the route must NOT use withDeadMansSwitch: it reports only at the END of the run, which is the "
      + "shape that left the 2026-09-04 territory re-stamp reading as stranded for 14 hours",
  );

  // THE HEADLINE. The route hands its reporter to the drain as the per-file commit hook, so the
  // first rebuilt file reports the run. Without this the ping sits behind a four-minute budget.
  assert.ok(
    route.includes("onFileRebuilt: reportSuccessOnce"),
    "the route must report success through the onFileRebuilt commit hook, not after the drain returns",
  );

  // An empty queue commits nothing, so it fires no hook — and it is the healthy steady state. A
  // quiet week must not read like a stopped clock.
  assert.ok(
    route.includes('pingDeadMansSwitch(JOB_SLUG, "success")'),
    "the route must still report success on the empty-queue path, which fires no commit hook",
  );
  const emptyPathAt = route.indexOf("pendingAtStart === 0");
  const successPingAt = route.indexOf('pingDeadMansSwitch(JOB_SLUG, "success")');
  assert.notEqual(emptyPathAt, -1, "the route must short-circuit when nothing is pending");
  assert.ok(
    successPingAt < emptyPathAt,
    "the success reporter must be defined before the empty-queue return, or that path answers 200 "
      + "while reporting nothing and the register calls a healthy clock stranded",
  );

  // Reporting success early must not silence a real fault.
  assert.match(
    route,
    /pingDeadMansSwitch\(JOB_SLUG, "fail"/,
    "the route must still report failure when the drain throws",
  );

  // ------------------------------------------------- the hook is honoured where the work commits

  const finishAt = drain.indexOf('.rpc("sos_finish_brick_move_file"');
  const hookAt = drain.indexOf("await options.onFileRebuilt?.()");
  const countAt = drain.indexOf("refreshed += 1");

  assert.notEqual(finishAt, -1, "the drain must still mark a rebuilt file as done");
  assert.notEqual(
    hookAt,
    -1,
    "refreshMovedBrickFiles must invoke the onFileRebuilt hook — without it the cron run's liveness "
      + "depends on a four-minute tail that a routine deploy can cut",
  );

  // AFTER the file is marked done, never before: a hook above that call would report success for a
  // rebuild that has not been recorded, and a false success is worse than no register at all.
  assert.ok(
    finishAt < hookAt,
    "onFileRebuilt must fire AFTER sos_finish_brick_move_file returns — never claim a run for work "
      + "that has not been recorded",
  );
  assert.ok(
    countAt < hookAt,
    "onFileRebuilt must fire after the file is counted, so the hook and the count can never disagree",
  );

  // Awaited, and wrapped. An unawaited ping dies with the container exactly as the tail did, and a
  // broken reporter must never turn a rebuild that has landed into a failed drain.
  assert.ok(
    !/(?<!await\s)\boptions\.onFileRebuilt\?\.\(\)/.test(drain),
    "the onFileRebuilt hook must be awaited — an unawaited promise dies with the container",
  );
  assert.ok(
    /try\s*\{\s*await options\.onFileRebuilt\?\.\(\);\s*\}\s*catch/.test(drain),
    "the onFileRebuilt call must be wrapped — a broken reporter must not fail a committed rebuild",
  );

  // ------------------------------------------------- 3. one cadence, two files

  const entryAt = sync.indexOf('"brick-move-drain": {');
  assert.notEqual(
    entryAt,
    -1,
    "scripts/cronjob-sync.mjs must know how to create this job — merging a cron route ships the code "
      + "and arms nothing, which is exactly how /api/cron/territory-restamp sat uncalled for weeks",
  );
  const entry = sync.slice(entryAt, sync.indexOf("requestTimeout", entryAt));
  assert.ok(
    entry.includes('path: "/api/cron/brick-move-drain"'),
    "the scheduler declaration must point at this route's own path",
  );

  const declaredMinutes = declaration?.schedule?.split(" ")[0] ?? "";
  const syncMinutes = /minutes:\s*\[([^\]]*)\]/
    .exec(entry)?.[1]
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join(",");
  assert.equal(
    syncMinutes,
    declaredMinutes,
    "the minutes in scripts/cronjob-sync.mjs must equal the minutes in JOB_SCHEDULES — drift between "
      + "them makes the heartbeat register judge a job that is firing perfectly well to be late",
  );
  assert.match(
    entry,
    /hours:\s*\[-1\]/,
    "the drain fires around the clock, matching the '*' hour field of its declared expression",
  );

  // ------------------------------------------------- the file the drain could never finish

  // phx_refresh_sos_fact_rollup was the one rollup refresh of the six with no statement_timeout of
  // its own, so it ran under the PostgREST role's 8s while its siblings set 60-120s. The largest
  // files exceed that, and a file the drain can never finish is retried for ever: the queue never
  // reaches zero, so the clock runs perfectly and the move stays half-applied.
  assert.match(
    migration,
    /alter function public\.phx_refresh_sos_fact_rollup\(uuid\) set statement_timeout/i,
    "phx_refresh_sos_fact_rollup must carry its own statement_timeout, or the biggest sales file in a "
      + "move can never be rebuilt and the drain never completes",
  );

  // ------------------------------------------------- the half a heartbeat cannot see

  // The register answers one question — is the clock still firing? — so the fault it can never
  // describe is the one where every fire succeeds and the queue still never empties. These are the
  // REAL functions, run against real inputs: the rule is logic, not a string in a file.

  const now = new Date("2026-10-12T12:00:00.000Z");
  const file = (overrides: Partial<Parameters<typeof assessStuckBrickMoveFiles>[0]["rows"][number]> = {}) => ({
    batchId: "11111111-1111-1111-1111-111111111111",
    movedAt: "2026-10-12T11:00:00.000Z",
    oldBrickId: "B209-1",
    refreshStartedAt: null,
    ...overrides,
  });

  assert.equal(
    BRICK_MOVE_STUCK_AFTER_MS,
    60 * 60 * 1000,
    "the threshold is an hour: the clock fires three times an hour and a fire rebuilds tens of files, "
      + "so an hour is far outside any honest backlog",
  );

  // An empty queue is the healthy steady state, not a silence to alert about.
  assert.equal(assessStuckBrickMoveFiles({ now, rows: [] }).healthy, true);

  // A queue that is simply working through a backlog must NOT page anyone. 59 minutes is a backlog.
  const draining = assessStuckBrickMoveFiles({
    now,
    rows: [file({ movedAt: "2026-10-12T11:01:00.000Z" })],
  });
  assert.equal(
    draining.healthy,
    true,
    "a file queued 59 minutes ago is a queue draining normally — alerting on it is how an alert gets "
      + "ignored",
  );

  // An hour is the line, and it is inclusive.
  const onTheLine = assessStuckBrickMoveFiles({ now, rows: [file()] });
  assert.equal(onTheLine.healthy, false, "a file queued exactly an hour ago is stuck");
  assert.equal(onTheLine.oldestWaitingMinutes, 60);
  assert.deepEqual(onTheLine.bricks, ["B209-1"]);

  // Oldest first, and the brick list is de-duplicated for the title and the alert key.
  const several = assessStuckBrickMoveFiles({
    now,
    rows: [
      file({ movedAt: "2026-10-12T10:00:00.000Z", oldBrickId: "B209B-1" }),
      file({ movedAt: "2026-10-12T09:00:00.000Z", oldBrickId: "B209-1" }),
      file({ batchId: "22222222-2222-2222-2222-222222222222", movedAt: "2026-10-12T09:30:00.000Z" }),
      file({ movedAt: "2026-10-12T11:59:00.000Z" }),
    ],
  });
  assert.equal(several.stuck.length, 3, "only the files past the threshold are stuck");
  assert.deepEqual(
    several.stuck.map((row) => row.movedAt),
    ["2026-10-12T09:00:00.000Z", "2026-10-12T09:30:00.000Z", "2026-10-12T10:00:00.000Z"],
    "stuck files come back oldest first — the message leads with the worst one",
  );
  assert.deepEqual(several.bricks, ["B209-1", "B209B-1"], "bricks are de-duplicated and ordered by age");
  assert.equal(several.oldestWaitingMinutes, 180);

  // A row whose timestamp cannot be read must never fire the alert. The first malformed row would
  // otherwise page a human about nothing, which is how an alert stops being read.
  assert.equal(
    assessStuckBrickMoveFiles({ now, rows: [file({ movedAt: "not a date" })] }).healthy,
    true,
    "an unparseable moved_at must never raise the alarm",
  );

  // ------------------------------------------------- the message says it in Cairo, in his terms

  const message = buildBrickMoveStuckMessage(
    assessStuckBrickMoveFiles({
      now,
      rows: [file({ movedAt: "2026-10-12T10:27:00.000Z", refreshStartedAt: "2026-10-12T11:45:00.000Z" })],
    }),
  );
  assert.match(message, /1 sales file\(s\) have been waiting 1h 33m/);
  assert.match(message, /B209-1/, "the message must name the brick, never only a count");
  // Cairo, never raw UTC: 10:27Z is 13:27 Cairo. A UTC reading would print the 10:27 below.
  assert.match(message, /12 Oct, 13:27 Cairo/, "times reported to the owner are Africa/Cairo local");
  assert.ok(!message.includes("10:27"), "the moved-at must not be printed as raw UTC");
  assert.match(message, /last attempted 12 Oct, 14:45/, "the last attempt is reported, also in Cairo");
  assert.match(
    buildBrickMoveStuckMessage(assessStuckBrickMoveFiles({ now, rows: [file()] })),
    /never attempted/,
    "a file the drain has never picked up must say so — it is a different fault from one that fails",
  );

  // ------------------------------------------------- no email, and it cannot take the route down

  assert.ok(
    !/channels:\s*\[[^\]]*"email"/.test(alert),
    "the stuck-queue alert must never add an outbound email — the owner's standing rule, and this "
      + "alert can fire while the pipeline it would send through is the broken thing",
  );
  assert.match(
    alert,
    /channels:\s*\["in_app", "telegram", "push"\]/,
    "in-app, Telegram and push — the channels a human actually reads",
  );
  assert.match(
    alert,
    /module:\s*"system"/,
    'module must be "system": an unknown module string fails closed in resolveTelegramGovernance and '
      + "silently drops the alert",
  );
  // Bucketed, or a queue stuck all day pages 72 times and is muted by hand the first afternoon.
  assert.match(alert, /cairoDayKey\(now\)/, "the alert must be bucketed per Cairo day");
  assert.match(
    alert,
    /verdict\.bricks\.join\(","\)/,
    "the bucket must include the stuck bricks, so a NEWLY stuck brick is not swallowed by an earlier key",
  );

  // The route reads the queue only when something is left, and a failure to read it must never fail
  // a drain that has already done its work.
  const guarded = /if \(result\.remaining > 0\) \{\s*try \{[\s\S]*?readPendingBrickMoveFiles\(\)/.test(route);
  assert.ok(
    guarded,
    "the route must only check for a stuck queue when files remain, inside a try — reading the queue "
      + "to complain about it must not become the complaint",
  );
  assert.ok(
    route.includes("notifyBrickMoveFilesStuck(verdict)"),
    "the route must dispatch the alert it assessed",
  );

  // ------------------------------------------------- the files are not the numbers

  // Rebuilding a file rebuilds its rollups. The store-split net that Sales vs Target divides by is
  // computed per PERIOD from the closing detail rows, and a file finished any way other than
  // through this app skips that step — which is how 74,741.23 EGP sat on the wrong area in
  // September 2026 with the queue reading zero. Every assertion below runs the REAL rule against an
  // injected client: the default reaches production, and this suite runs with production
  // credentials.

  const settleHarness = (options: {
    periodsByBatch: Record<string, string[]>;
    status: { period: string; last_moved_at: string; net_computed_at: string | null }[];
    published?: string[];
    refreshError?: string;
  }) => {
    const calls: string[] = [];
    const client = {
      from(table: string) {
        if (table === "source_of_sales_fact_rollup") {
          return {
            select: () => ({
              eq: (_column: string, batchId: unknown) =>
                Promise.resolve({
                  data: (options.periodsByBatch[String(batchId)] ?? []).map((period) => ({ period })),
                  error: null,
                }),
            }),
          };
        }
        if (table === "monthly_closing_publications") {
          return {
            select: () => ({
              in: () => ({
                is: () =>
                  Promise.resolve({
                    data: (options.published ?? []).map((period) => ({ period })),
                    error: null,
                  }),
              }),
            }),
          };
        }
        throw new Error("the settle must not read " + table);
      },
      rpc(fn: string, args: Record<string, unknown>) {
        if (fn === "phx_brick_move_period_net_status") {
          return Promise.resolve({ data: options.status, error: null });
        }
        if (fn === "phx_refresh_attribution_for_period") {
          calls.push("refresh:" + String(args.p_period));
          return Promise.resolve({
            data: null,
            error: options.refreshError ? { message: options.refreshError } : null,
          });
        }
        throw new Error("the settle must not call " + fn);
      },
    } as SettleSupabase;
    const writeNetForPeriods = async (_client: SettleSupabase, periods: readonly string[]) => {
      calls.push("net:" + periods.join(","));
    };
    return { calls, client, writeNetForPeriods };
  };

  const MOVED = "2026-10-12T23:03:23.731Z";
  const BEFORE = "2026-10-12T14:03:41.823Z";
  const AFTER = "2026-10-12T23:09:52.138Z";

  // 1. A stale period is settled, and the NET IS WRITTEN BEFORE THE RE-STAMP. That order is the
  //    whole point: au.f_monthly_attribution reads the net, so re-stamping first bakes the
  //    pre-move split into the rollup and leaves it there.
  {
    const h = settleHarness({
      periodsByBatch: { "batch-a": ["2026-09"] },
      status: [{ last_moved_at: MOVED, net_computed_at: BEFORE, period: "2026-09" }],
    });
    const out = await settleBrickMoveNet({
      batchIds: ["batch-a"],
      supabase: h.client,
      writeNetForPeriods: h.writeNetForPeriods,
    });
    assert.deepEqual(out.settled, ["2026-09"], "a period whose net predates the move must be settled");
    assert.deepEqual(
      h.calls,
      ["net:2026-09", "refresh:2026-09"],
      "the net must be written BEFORE attribution is re-stamped, or the rollup keeps the pre-move split",
    );
    assert.equal(out.failure, null);
  }

  // 2. A period already current is left alone. Recomputing is idempotent but not free, and a
  //    needless pass on every fire is how a settle step becomes a standing cost.
  {
    const h = settleHarness({
      periodsByBatch: { "batch-a": ["2026-09"] },
      status: [{ last_moved_at: MOVED, net_computed_at: AFTER, period: "2026-09" }],
    });
    const out = await settleBrickMoveNet({
      batchIds: ["batch-a"],
      supabase: h.client,
      writeNetForPeriods: h.writeNetForPeriods,
    });
    assert.deepEqual(out.alreadyCurrent, ["2026-09"]);
    assert.deepEqual(out.settled, []);
    assert.deepEqual(h.calls, [], "a current period must not be rewritten");
  }

  // 3. 🔴 A PUBLISHED MONTH IS NEVER WRITTEN. The database refuses it anyway, but it is skipped by
  //    name and reported: re-stamping a published month moves numbers under a closing that has
  //    already gone out, which is the owner's decision and never a side effect of a brick move.
  {
    const h = settleHarness({
      periodsByBatch: { "batch-a": ["2026-07", "2026-09"] },
      published: ["2026-07"],
      status: [
        { last_moved_at: MOVED, net_computed_at: BEFORE, period: "2026-07" },
        { last_moved_at: MOVED, net_computed_at: BEFORE, period: "2026-09" },
      ],
    });
    const out = await settleBrickMoveNet({
      batchIds: ["batch-a"],
      supabase: h.client,
      writeNetForPeriods: h.writeNetForPeriods,
    });
    assert.deepEqual(out.skippedPublished, ["2026-07"]);
    assert.deepEqual(out.settled, ["2026-09"], "the unpublished period must still be settled");
    assert.ok(
      !h.calls.some((call) => call.includes("2026-07")),
      "a published month must not be written or re-stamped at all",
    );
  }

  // 4. Periods the city split does not reach have an empty net BY DESIGN. Treating one as stale
  //    would recompute it on every fire for ever and never satisfy itself.
  {
    const h = settleHarness({
      periodsByBatch: { "batch-a": ["2026-01", "2026-09"] },
      status: [
        { last_moved_at: MOVED, net_computed_at: null, period: "2026-01" },
        { last_moved_at: MOVED, net_computed_at: BEFORE, period: "2026-09" },
      ],
    });
    const out = await settleBrickMoveNet({
      batchIds: ["batch-a"],
      supabase: h.client,
      writeNetForPeriods: h.writeNetForPeriods,
    });
    assert.deepEqual(out.outsideSplit, ["2026-01"], "January is before the split starts");
    assert.deepEqual(out.settled, ["2026-09"]);
    assert.ok(!h.calls.some((call) => call.includes("2026-01")));
  }

  // 5. A period with no status row is treated as CURRENT. The status read looks back three days,
  //    so absence means the move is older than the window, not that it was never settled.
  {
    const h = settleHarness({ periodsByBatch: { "batch-a": ["2026-09"] }, status: [] });
    const out = await settleBrickMoveNet({
      batchIds: ["batch-a"],
      supabase: h.client,
      writeNetForPeriods: h.writeNetForPeriods,
    });
    assert.deepEqual(out.settled, []);
    assert.deepEqual(h.calls, [], "no status row must never trigger a rewrite");
  }

  // 6. The per-fire cap holds, and what it leaves is reported rather than dropped.
  {
    const periods = ["2026-07", "2026-08", "2026-09", "2026-10"];
    const h = settleHarness({
      periodsByBatch: { "batch-a": periods },
      status: periods.map((period) => ({ last_moved_at: MOVED, net_computed_at: BEFORE, period })),
    });
    const out = await settleBrickMoveNet({
      batchIds: ["batch-a"],
      supabase: h.client,
      writeNetForPeriods: h.writeNetForPeriods,
    });
    assert.equal(
      out.settled.length,
      SETTLE_PERIODS_PER_RUN,
      "one move must never become a four-minute recompute — the cap is what bounds it",
    );
    assert.deepEqual(out.deferred, ["2026-10"], "what the cap left must be reported, not dropped");
  }

  // 7. A failing re-stamp stops the loop, reports why, and does not claim the period landed.
  {
    const h = settleHarness({
      periodsByBatch: { "batch-a": ["2026-08", "2026-09"] },
      refreshError: "canceling statement due to statement timeout",
      status: [
        { last_moved_at: MOVED, net_computed_at: BEFORE, period: "2026-08" },
        { last_moved_at: MOVED, net_computed_at: BEFORE, period: "2026-09" },
      ],
    });
    const out = await settleBrickMoveNet({
      batchIds: ["batch-a"],
      supabase: h.client,
      writeNetForPeriods: h.writeNetForPeriods,
    });
    assert.deepEqual(out.settled, [], "a period whose re-stamp failed must not be reported as settled");
    assert.match(out.failure ?? "", /statement timeout/);
    assert.deepEqual(out.deferred, ["2026-08", "2026-09"], "both are still owed");
  }

  // 8. The route settles only after real work — a standing sweep would recompute a published
  //    month, or a legitimately empty net, on every one of the day's 72 fires.
  assert.ok(
    route.includes("if (result.refreshed > 0) {"),
    "the route must settle only on a fire that actually rebuilt something",
  );
  assert.ok(
    route.includes("settleBrickMoveNet({ batchIds: result.rebuiltBatchIds })"),
    "the route must settle exactly the batches it rebuilt",
  );

  // ------------------------------------------- the residue nothing will retry has to reach a human

  // The settle closes the common case. What it REFUSES to write is the case that bit on 2026-10-13
  // in a different shape: a figure left wrong on a screen with nothing saying so. Two leftovers can
  // never clear themselves and must page; the third clears on the next fire and must not, or the
  // alert fires on a healthy move and is muted by the first afternoon.

  // 9. The per-fire cap alone is NOT residue. Three periods settled, a fourth deferred, no failure
  //    — the next fire takes it, so waking him for it would train him to ignore this alert.
  {
    const verdict = assessUnsettledBrickMoveNet({
      deferred: ["2026-10"],
      failure: null,
      skippedPublished: [],
    });
    assert.equal(
      verdict.healthy,
      true,
      "a period the cap merely deferred must NOT page — the very next fire settles it",
    );
    assert.deepEqual(verdict.owedPeriods, []);
  }

  // 10. 🔴 A published month DOES page. phx_write_monthly_store_split_net refuses it by design, so
  //     nothing will ever retry it, and re-stamping a closing that has gone out is HIS decision.
  {
    const verdict = assessUnsettledBrickMoveNet({
      deferred: [],
      failure: null,
      skippedPublished: ["2026-07"],
    });
    assert.equal(verdict.healthy, false, "a published month whose net predates the move can never settle itself");
    assert.deepEqual(verdict.periods, ["2026-07"]);
    const message = buildBrickMoveNetUnsettledMessage(verdict);
    assert.match(message, /2026-07/);
    assert.match(
      message,
      /Unpublish the month on Monthly Closing/,
      "the alert must name the one screen where he can actually fix it",
    );
    assert.ok(
      !/Could not be settled/.test(message),
      "with no failure the message must not claim one — a published month was skipped on purpose",
    );
  }

  // 11. A failed settle pages, names the reason, and lists what is still owed. The retry only comes
  //     with the next file rebuild, and once the queue is empty there is no next rebuild.
  {
    const verdict = assessUnsettledBrickMoveNet({
      deferred: ["2026-08", "2026-09"],
      failure: "canceling statement due to statement timeout",
      skippedPublished: [],
    });
    assert.equal(verdict.healthy, false);
    assert.deepEqual(verdict.owedPeriods, ["2026-08", "2026-09"]);
    const message = buildBrickMoveNetUnsettledMessage(verdict);
    assert.match(message, /Reason: canceling statement due to statement timeout/);
    assert.match(message, /will\s*\n?\s*not clear on its own/);
  }

  // 12. Both residues at once report both, de-duplicated and sorted — the title and the alert key
  //     are built from that list, so a NEW month going unsettled must not reuse an earlier key.
  {
    const verdict = assessUnsettledBrickMoveNet({
      deferred: ["2026-09", "2026-07"],
      failure: "boom",
      skippedPublished: ["2026-07"],
    });
    assert.deepEqual(verdict.periods, ["2026-07", "2026-09"]);
  }

  // 13. The same channel rules as the stuck-queue alert, for the same reasons.
  assert.ok(
    !/channels:\s*\[[^\]]*"email"/.test(netAlert),
    "the unsettled-net alert must never add an outbound email — the owner's standing rule",
  );
  assert.match(
    netAlert,
    /channels:\s*\["in_app", "telegram", "push"\]/,
    "in-app, Telegram and push — the channels a human actually reads",
  );
  assert.match(
    netAlert,
    /module:\s*"system"/,
    'module must be "system": an unknown module string fails closed in resolveTelegramGovernance and '
      + "silently drops the alert",
  );
  assert.match(netAlert, /cairoDayKey\(now\)/, "the alert must be bucketed per Cairo day");
  assert.match(
    netAlert,
    /verdict\.periods\.join\(","\)/,
    "the bucket must include the unsettled periods, so a NEWLY unsettled month is not swallowed by "
      + "an earlier key",
  );

  // 14. The route pages on the VERDICT, never on the raw settle result — that is the only thing
  //     that keeps a capped period out of his Telegram.
  assert.ok(
    route.includes("assessUnsettledBrickMoveNet(settle)"),
    "the route must assess the residue rather than page on the raw settle result",
  );
  assert.ok(
    route.includes("notifyBrickMoveNetUnsettled(residue)"),
    "the route must dispatch the residue alert it assessed",
  );
  assert.ok(
    /if \(!residue\.healthy\) \{[\s\S]*?notifyBrickMoveNetUnsettled\(residue\)/.test(route),
    "the page must be inside the not-healthy branch, or every clean drain alerts",
  );
}
