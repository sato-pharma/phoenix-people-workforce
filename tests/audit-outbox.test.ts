import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AUDIT_INSERT_RETRY_TIMEOUT_MS,
  AUDIT_INSERT_TIMEOUT_MS,
  auditLogRow,
  readQueuedAuditLog,
} from "../src/lib/admin/audit-outbox.ts";
import { isErrorMonitorSelfReport } from "../src/lib/observability/log.ts";
import {
  describeOutboxError,
  firstAttemptSpentItsBudget,
  nextAttemptDelayMs,
  OUTBOX_DRAIN_INTERVAL_MS,
  OUTBOX_FIRST_ATTEMPT_SPENT_SLACK_MS,
  OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS,
  OUTBOX_MAX_BACKOFF_MS,
  OUTBOX_RETRY_TIMEOUT_MS,
  type OutboxQueue,
  persistThroughOutbox,
  shouldDrainNow,
} from "../src/lib/platform/write-outbox.ts";

/**
 * THE WRITE OUTBOX — the mechanism, and the audit trail's half of it.
 *
 * Why it exists, measured on production 23 Oct 2026:
 *
 *   1. `insertAuditLog` ran on a 3-second client timeout with no retry and no queue. 109
 *      `audit_persistence_failed` errors in 21 days, and the loss is real: the notification logged
 *      at 16:19 Cairo (entity f67a82b2-…) has no `audit_logs` row while its neighbours from the
 *      same minute do.
 *   2. `persistErrorEvent` held a MODULE-WIDE re-entrancy flag, so any error logged while another
 *      error's insert was in flight never reached `app_error_events`. All 109 failures logged two
 *      lines and left exactly one row — the table's counts were a floor.
 *
 *   The cause of (1) was not the audit trail's own load: production Postgres restarted FOUR times
 *   between 11:30 and 14:25 Cairo on 22 October, which is where 40 of the 109 sit.
 *
 * 🔴 THE DUPLICATE GUARD IS PROVED BEHAVIOURALLY, NOT BY READING THE SOURCE. A client-side abort
 * is the client giving up, not Postgres rolling back, so a blind retry writes some rows twice. The
 * stub queue below is the only honest way to show the probe actually short-circuits the retry.
 */
export async function runAuditOutboxTests() {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

  const AUDIT = "src/lib/admin/audit.ts";
  const AUDIT_OUTBOX = "src/lib/admin/audit-outbox.ts";
  const LOG = "src/lib/observability/log.ts";
  const SERVICE = "src/lib/error-monitor/service.ts";

  // ── A STUB QUEUE: THE MECHANISM, WITHOUT A DATABASE ──────────────────────────────────────────
  //
  // Nothing here reaches Supabase. The queue-write path deliberately is NOT exercised: this suite
  // runs with PRODUCTION credentials, so a test that queued for real would write to the live table.
  type Call = { timeoutMs: number };
  function stubQueue(options: { landFailures: number; landed: boolean }) {
    const calls: Call[] = [];
    let probes = 0;
    const queue: OutboxQueue<{ id: string }> = {
      alreadyLanded: async () => {
        probes += 1;
        return options.landed;
      },
      land: async (_payload, timeoutMs) => {
        calls.push({ timeoutMs });
        if (calls.length <= options.landFailures) throw new Error("AbortError: Supabase request timed out.");
      },
      read: (payload) => payload as { id: string },
      table: "stub_outbox",
    };
    return { calls, probeCount: () => probes, queue };
  }

  // The ordinary path: one write, one success, the drain nudged.
  {
    const { calls, probeCount, queue } = stubQueue({ landFailures: 0, landed: false });
    let drained = 0;
    const error = await persistThroughOutbox(queue, { id: "a" }, () => { drained += 1; });
    assert.equal(error, null, "a write that lands must report no error");
    assert.equal(calls.length, 1, "and must not be attempted twice");
    assert.equal(calls[0].timeoutMs, OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS, "the first attempt runs on the request path");
    assert.equal(probeCount(), 0, "nothing failed, so nothing is probed");
    assert.equal(drained, 1, "a successful write nudges the drain — that is the whole scheduler");
  }

  // 🔴 THE ONE THAT MATTERS: the first attempt timed out but the row DID commit.
  {
    const { calls, probeCount, queue } = stubQueue({ landFailures: 1, landed: true });
    const error = await persistThroughOutbox(queue, { id: "b" });
    assert.equal(error, null, "a write that had already landed is not an error");
    assert.equal(
      calls.length,
      1,
      "THE WRITE WAS ATTEMPTED TWICE AFTER IT HAD ALREADY LANDED. A client-side abort is the client " +
        "giving up, not Postgres rolling back — retrying past a successful commit is how 'never " +
        "lose a row' becomes 'write some rows twice', and for a notification that is a second real " +
        "message to a real person.",
    );
    assert.equal(probeCount(), 1, "and the probe is what must have stopped it");
  }

  // Genuinely failed, then succeeded: the retry gets the longer timeout.
  {
    const { calls, queue } = stubQueue({ landFailures: 1, landed: false });
    let drained = 0;
    const error = await persistThroughOutbox(queue, { id: "c" }, () => { drained += 1; });
    assert.equal(error, null, "the retry landed, so there is no error to report");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].timeoutMs, OUTBOX_RETRY_TIMEOUT_MS, "the retry must be more patient than the attempt that failed");
    assert.ok(OUTBOX_RETRY_TIMEOUT_MS > OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS, "or it adds nothing at all");
    assert.equal(drained, 1);
  }

  // 🔴 A FIRST ATTEMPT THAT SPENT ITS WHOLE BUDGET IS QUEUED AT ONCE — no probe, no retry here.
  //
  // Measured on production 26 Oct 2026, 09:31–09:33 UTC: 13 `supabase.fetch.timeout`, every one of
  // them a FIRST attempt, every elapsed reading 3,000–3,107 ms. The old cap aborted the write and
  // then spent two MORE round trips — the probe and the patient retry — while the request waited.
  // Queueing straight away does the same job with nobody waiting: the drain probes `alreadyLanded`
  // before it lands anything, so the duplicate guard moves off the request rather than weakening.
  //
  // The clock is stubbed because the branch needs a wall-clock 8 seconds, and a suite that waits
  // that long for one assertion is a suite that gets skipped.
  {
    const realNow = Date.now;
    let clock = 1_700_000_000_000;
    Date.now = () => clock;
    try {
      const calls: Call[] = [];
      let probes = 0;
      let queueableAsked = 0;
      // `queueable` answering NO is what keeps this case off the network: persistThroughOutbox then
      // skips `queueOutboxWrite` entirely. This suite runs with PRODUCTION credentials.
      const queue: OutboxQueue<{ id: string }> = {
        alreadyLanded: async () => {
          probes += 1;
          return false;
        },
        land: async (_payload, timeoutMs) => {
          calls.push({ timeoutMs });
          clock += timeoutMs; // the attempt held the request for its whole budget, then aborted
          throw new Error("AbortError: Supabase request timed out.");
        },
        queueable: () => {
          queueableAsked += 1;
          return false;
        },
        read: (payload) => payload as { id: string },
        table: "stub_outbox",
      };
      let drained = 0;
      const error = await persistThroughOutbox(queue, { id: "d" }, () => { drained += 1; });
      assert.equal(
        calls.length,
        1,
        "A FIRST ATTEMPT THAT SPENT ITS WHOLE BUDGET WAS RETRIED ON THE SAME REQUEST. That is what " +
          "made the short cap expensive instead of cheap: one write could hold one request for the " +
          "first attempt plus a probe plus a retry plus the queue write. The queue already " +
          "guarantees the row survives, and its drain probes before it lands.",
      );
      assert.equal(
        probes,
        0,
        "AND IT MUST NOT BE PROBED EITHER — the probe is a further round trip on a request that has " +
          "already waited out the whole budget, and the drain runs the same probe for free later.",
      );
      assert.equal(
        queueableAsked,
        1,
        "the write must still be offered to the queue — queueing immediately is the point, not " +
          "skipping the queue, or the raise would trade a slow write for a lost one.",
      );
      assert.ok(error, "and the caller must still be told its write did not land on this request");
      assert.equal(drained, 0, "nothing landed, so the drain is not nudged");
    } finally {
      Date.now = realNow;
    }
  }
  // An attempt that fails INSIDE its budget still gets the probe and the retry — the database-restart
  // case the file was built for. Proved by the two scenarios above, whose stub throws at once.

  // ── THE BUDGET CLEARS WHAT A SUPABASE ROUND TRIP ACTUALLY COSTS ──────────────────────────────
  //
  // 🔴 THIS NUMBER IS MEASURED, NOT CHOSEN. From `process_health`'s own `timings.supabase.fetch` on
  // production, 26 Oct 2026 09:31–09:33 UTC — the CLIENT's round trip, not the query:
  //
  //     09:31  2,060 calls   p50 1,396 ms   p95 2,988 ms   max 8,061 ms
  //     09:32  2,266 calls   p50 1,998 ms   p95 3,494 ms   max 5,762 ms
  //     09:33  2,143 calls   p50 1,760 ms   p95 3,512 ms   max 5,680 ms
  //
  // The database was never the reason: `pg_stat_statements` on `ozucdzovmcqvepbozvqf` put the
  // inserts behind those aborts at a mean of 0.5–3.3 ms, worst case 118.8 ms, over 8,626 calls.
  const MEASURED_ROUND_TRIP_P95_MS = 3_512;
  assert.ok(
    OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS >= MEASURED_ROUND_TRIP_P95_MS * 2,
    `THE FIRST ATTEMPT'S BUDGET IS BELOW WHAT THE ROUND TRIP COSTS. It is ` +
      `${OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS} ms and the measured p95 on production is ` +
      `${MEASURED_ROUND_TRIP_P95_MS} ms. At 3,000 ms it sat BETWEEN the p50 and the p95 and aborted ` +
      "13 ordinary writes in three minutes — a budget under the p95 makes a healthy write look like " +
      "an outage, and it is the transport that is slow, never the insert.",
  );
  assert.ok(
    OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS < OUTBOX_RETRY_TIMEOUT_MS,
    "and it must stay under the retry's, or the retry is not more patient than what it retries.",
  );
  // Both must stay under the transport's own ceiling, or the client aborts before the outbox's timer
  // and `elapsedMs` stops meaning what `firstAttemptSpentItsBudget` reads it as.
  const serverSource = read("src/lib/supabase/server.ts");
  const transportCeiling = Number(/const supabaseRequestTimeoutMs = (\d+);/.exec(serverSource)?.[1]);
  assert.ok(Number.isFinite(transportCeiling), "src/lib/supabase/server.ts must still declare supabaseRequestTimeoutMs.");
  assert.ok(
    OUTBOX_RETRY_TIMEOUT_MS < transportCeiling,
    `both outbox budgets must stay under the transport ceiling (${transportCeiling} ms), or the ` +
      "client's own abort fires first and the outbox never sees its own timeout.",
  );
  assert.equal(
    AUDIT_INSERT_TIMEOUT_MS,
    OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS,
    "the audit trail must not keep a request-path budget of its own — it is the same container, the " +
      "same client and the same round trip, and a second number drifts.",
  );
  assert.equal(AUDIT_INSERT_RETRY_TIMEOUT_MS, OUTBOX_RETRY_TIMEOUT_MS);

  // ── SPENT ITS BUDGET, OR FAILED INSIDE IT ────────────────────────────────────────────────────
  assert.equal(firstAttemptSpentItsBudget(OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS), true, "running the clock out is spending it");
  assert.equal(
    firstAttemptSpentItsBudget(OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS - OUTBOX_FIRST_ATTEMPT_SPENT_SLACK_MS),
    true,
    "and so is ending inside the slack: the abort timer fires LATE under event-loop pressure, and " +
      "this container's `eventLoopDelayMs` max was 920 / 811 / 1,725 ms in the same three minutes.",
  );
  assert.equal(
    firstAttemptSpentItsBudget(OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS - OUTBOX_FIRST_ATTEMPT_SPENT_SLACK_MS - 1),
    false,
    "a millisecond earlier is a real failure, not a spent budget — it keeps the probe and the retry.",
  );
  assert.equal(
    firstAttemptSpentItsBudget(0),
    false,
    "and a PostgREST rejection comes back at once: that is the database-restart case, where a second " +
      "attempt seconds later often lands.",
  );
  assert.ok(
    OUTBOX_FIRST_ATTEMPT_SPENT_SLACK_MS > 0 && OUTBOX_FIRST_ATTEMPT_SPENT_SLACK_MS < OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS / 4,
    "the slack absorbs a late timer; widening it towards the budget would send genuine fast failures " +
      "to the queue instead of retrying them.",
  );

  // ── THE BACK-OFF DOUBLES AND THEN STOPS ──────────────────────────────────────────────────────
  assert.equal(nextAttemptDelayMs(1), 60_000, "first retry waits a minute");
  assert.equal(nextAttemptDelayMs(2), 120_000, "then two");
  assert.equal(nextAttemptDelayMs(3), 240_000, "then four");
  assert.equal(nextAttemptDelayMs(7), OUTBOX_MAX_BACKOFF_MS, "and caps at an hour");
  assert.equal(nextAttemptDelayMs(500), OUTBOX_MAX_BACKOFF_MS, "for ever, never giving up");
  assert.ok(nextAttemptDelayMs(0) > 0, "a zero attempt count must still wait, not spin");

  // ── THE DRAIN IS THROTTLED PER PROCESS ───────────────────────────────────────────────────────
  const now = 1_000_000;
  assert.equal(shouldDrainNow(0, now, false), true, "a process that has never drained drains");
  assert.equal(shouldDrainNow(now - 1_000, now, false), false, "but not again a second later");
  assert.equal(shouldDrainNow(now - OUTBOX_DRAIN_INTERVAL_MS, now, false), true, "once the interval is up it drains again");
  assert.equal(shouldDrainNow(0, now, true), false, "and never while a drain is already in flight");

  // ── THE DRAIN WRITES WHAT THE CALLER MEANT ───────────────────────────────────────────────────
  assert.deepEqual(
    auditLogRow({ entityType: "auth_session", summary: "signed in" }),
    {
      actor_login_id: "system",
      entity_id: null,
      entity_type: "auth_session",
      new_values: null,
      old_values: null,
      summary: "signed in",
    },
    "an input with no actor and no entity must still produce a complete row",
  );

  // ── A STORED PAYLOAD IS CHECKED BEFORE IT IS TRUSTED ─────────────────────────────────────────
  assert.equal(readQueuedAuditLog(null), null);
  assert.equal(readQueuedAuditLog({}), null);
  assert.equal(readQueuedAuditLog({ input: { summary: "x" } }), null, "no entityType, nothing to write");
  assert.equal(readQueuedAuditLog({ input: { entityType: "auth_session" } }), null, "no summary either");
  const queued = readQueuedAuditLog({
    attemptedAt: "2026-10-23T13:19:00.000Z",
    input: { entityType: "auth_session", summary: "signed in" },
  });
  assert.ok(queued, "a well-formed payload must be readable");
  assert.equal(queued.attemptedAt, "2026-10-23T13:19:00.000Z");
  const undated = readQueuedAuditLog({ input: { entityType: "auth_session", summary: "signed in" } });
  assert.ok(undated, "a payload with no attemptedAt is still worth writing");
  assert.equal(undated.attemptedAt, new Date(0).toISOString(), "falling back to the epoch widens the probe, never narrows it");

  // ── THE QUEUE SAYS WHY, IN ONE LINE ──────────────────────────────────────────────────────────
  //
  // 🔴 A SUPABASE REJECTION IS NOT AN `Error` — PostgREST rethrows a plain object, which is how the
  // stack column of app_error_events used to land empty (see persistedStack in log.ts).
  assert.equal(describeOutboxError(new Error("boom")), "Error: boom");
  assert.equal(
    describeOutboxError({ code: "57014", message: "canceling statement due to statement timeout" }),
    "57014 canceling statement due to statement timeout",
    "a PostgREST rejection must be readable, not '[object Object]'",
  );
  assert.ok(describeOutboxError(undefined).length > 0, "even an undefined cause leaves something readable");
  assert.ok(describeOutboxError(new Error("x".repeat(5_000))).length <= 500, "and it stays short");

  // ── THE AUDIT PATH USES THE MECHANISM, AND STILL RAISES FOR A REQUIRED ROW ───────────────────
  const auditSource = read(AUDIT);
  assert.ok(
    auditSource.includes("persistAuditLogThroughOutbox"),
    `${AUDIT} must persist through the outbox. Without it a timed-out write is lost, which is the ` +
      "defect this was opened for.",
  );
  assert.ok(
    auditSource.includes("throw new AuditPersistenceError"),
    `${AUDIT} must still throw for a REQUIRED audit row. The queue stops the row being lost; it does ` +
      "not decide for the caller that the act may proceed unrecorded.",
  );
  const outboxSource = read(AUDIT_OUTBOX);
  assert.ok(
    outboxSource.includes("idx_audit_logs_actor_entity") || outboxSource.includes("actor_login_id"),
    `${AUDIT_OUTBOX}'s landing probe must read through the actor/entity index, not scan.`,
  );

  // ── ONE FAILURE, ONE LOG LINE ────────────────────────────────────────────────────────────────
  //
  // Both failure paths used to log the SAME event twice, and the second never persisted because of
  // the module-wide flag below. With that flag fixed, a second line would be a second ROW.
  const countOf = (needle: string) => auditSource.split(needle).length - 1;
  assert.equal(
    countOf('event: "audit_persistence_failed"'),
    1,
    `${AUDIT} logs audit_persistence_failed more than once per failure — now that persistErrorEvent ` +
      "no longer swallows the second line, that is a duplicate row in app_error_events.",
  );
  assert.equal(countOf('event: "critical_audit_persistence_failed"'), 1);

  // ── THE SELF-REPORT BLOCK NAMES EXACTLY WHAT CAN RECURSE ─────────────────────────────────────
  assert.equal(isErrorMonitorSelfReport({ event: "app_error_insert_failed" }), true);
  assert.equal(isErrorMonitorSelfReport({ event: "log_app_error_threw" }), true);
  assert.equal(
    isErrorMonitorSelfReport({ event: "audit_persistence_failed" }),
    false,
    "every other error must reach app_error_events — dropping them is the defect, not the guard.",
  );
  assert.equal(isErrorMonitorSelfReport(undefined), false);
  assert.equal(isErrorMonitorSelfReport({}), false);

  // Both blocked names must still be raised by `logAppError` itself. If one is renamed and this is
  // not, the loop the block exists to stop comes straight back.
  const serviceSource = read(SERVICE);
  const logAppErrorStart = serviceSource.indexOf("export async function logAppError");
  assert.ok(logAppErrorStart > 0, `${SERVICE} must still export logAppError.`);
  const logAppErrorBody = serviceSource.slice(logAppErrorStart, serviceSource.indexOf("export type ReproTrailEntry"));
  for (const event of ["app_error_insert_failed", "log_app_error_threw"]) {
    assert.ok(
      logAppErrorBody.includes(`event: "${event}"`),
      `${SERVICE}'s logAppError no longer raises ${event}, but log.ts still blocks it by name — ` +
        "whatever replaced it will recurse.",
    );
  }

  const logSource = read(LOG);
  assert.ok(
    !/let persistingErrorEvent/.test(logSource),
    `${LOG} still holds the module-wide re-entrancy flag. It dropped every error logged while any ` +
      "other error's insert was in flight, which is why app_error_events counts were a floor.",
  );
  assert.ok(
    logSource.includes("if (isErrorMonitorSelfReport(labels)) return;"),
    `${LOG}'s persistErrorEvent must block the two self-reports by name — nothing else stops the loop.`,
  );

  // ── THE QUEUE HAS A TABLE TO LAND IN ─────────────────────────────────────────────────────────
  //
  // CI reads migration FILES and never touches a database, so this is a file check, not proof the
  // table exists. Both tables were applied and read back out of pg_class on both projects by hand.
  const migration = read("supabase/migrations/20261023190001_audit_log_outbox.sql");
  assert.ok(migration.includes("create table if not exists public.audit_log_outbox"), "the queue needs its table");
  for (const column of ["payload jsonb", "attempts integer", "last_error", "next_attempt_at", "created_at"]) {
    assert.ok(migration.includes(column), `audit_log_outbox is missing ${column}`);
  }
  assert.ok(migration.includes("enable row level security"), "audit_log_outbox is service-role only, like audit_logs.");
  assert.ok(
    migration.includes("revoke all on public.audit_log_outbox from anon, authenticated"),
    "a table in `public` is born readable to the browser keys unless the grant is revoked.",
  );
}
