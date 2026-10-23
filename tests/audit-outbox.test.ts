import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AUDIT_INSERT_RETRY_TIMEOUT_MS,
  AUDIT_INSERT_TIMEOUT_MS,
  AUDIT_OUTBOX_DRAIN_INTERVAL_MS,
  AUDIT_OUTBOX_MAX_BACKOFF_MS,
  auditLogRow,
  describeQueueError,
  nextAttemptDelayMs,
  readQueuedAuditLog,
  shouldDrainNow,
} from "../src/lib/admin/audit-outbox.ts";
import { isErrorMonitorSelfReport } from "../src/lib/observability/log.ts";

/**
 * THE AUDIT TRAIL MUST NOT LOSE ROWS, AND THE ERROR TABLE MUST NOT HIDE THAT IT DID.
 *
 * Two defects measured on production 23 Oct 2026, fixed together because the second is what made
 * the first hard to see:
 *
 *   1. `insertAuditLog` ran on a 3-second client timeout with no retry and no queue. 109
 *      `audit_persistence_failed` errors in 21 days, 40 on 22 Oct alone — and the loss is real:
 *      the notification logged at 16:19 Cairo (entity f67a82b2-…) has no `audit_logs` row while
 *      its neighbours from the same minute do.
 *   2. `persistErrorEvent` held a MODULE-WIDE re-entrancy flag, so any error logged while another
 *      error's insert was in flight never reached `app_error_events`. Every one of those 109
 *      failures logged two lines and left exactly one row — so the table's counts were a floor.
 *
 * What is pinned here is the mechanism on both sides: the queue's arithmetic and payload handling
 * (pure, no database), and at source level that the retry probes before it writes, that a failure
 * is queued, that the self-report block names exactly the two events that can recurse, and that
 * the duplicate log line is gone — because with the flag fixed, a second line is now a second ROW.
 */
export function runAuditOutboxTests() {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

  const AUDIT = "src/lib/admin/audit.ts";
  const OUTBOX = "src/lib/admin/audit-outbox.ts";
  const LOG = "src/lib/observability/log.ts";
  const SERVICE = "src/lib/error-monitor/service.ts";

  // ── THE REQUEST PATH STAYS FAST, THE RETRY GETS ROOM ─────────────────────────────────────────
  assert.equal(
    AUDIT_INSERT_TIMEOUT_MS,
    3_000,
    "The FIRST audit attempt must stay at 3s — it runs inside somebody's request and the whole " +
      "point of the outbox is that the trail no longer needs the request path to wait for it.",
  );
  assert.ok(
    AUDIT_INSERT_RETRY_TIMEOUT_MS > AUDIT_INSERT_TIMEOUT_MS,
    "The retry must be more patient than the attempt that already timed out, or it adds nothing.",
  );

  // ── THE BACK-OFF DOUBLES AND THEN STOPS ──────────────────────────────────────────────────────
  //
  // One unwritable row must not soak up every drain, and must not be abandoned either: a row that
  // cannot be written today is still the only record that something happened.
  assert.equal(nextAttemptDelayMs(1), 60_000, "first retry waits a minute");
  assert.equal(nextAttemptDelayMs(2), 120_000, "then two");
  assert.equal(nextAttemptDelayMs(3), 240_000, "then four");
  assert.equal(nextAttemptDelayMs(7), AUDIT_OUTBOX_MAX_BACKOFF_MS, "and caps at an hour");
  assert.equal(nextAttemptDelayMs(500), AUDIT_OUTBOX_MAX_BACKOFF_MS, "for ever, never giving up");
  assert.ok(nextAttemptDelayMs(0) > 0, "a zero attempt count must still wait, not spin");

  // ── THE DRAIN IS THROTTLED PER PROCESS ───────────────────────────────────────────────────────
  //
  // It rides on real audit traffic rather than a cron (no cron-job.org or Healthchecks slot is
  // free), so busy minutes must not turn every audit write into a queue scan.
  const now = 1_000_000;
  assert.equal(shouldDrainNow(0, now, false), true, "a process that has never drained drains");
  assert.equal(shouldDrainNow(now - 1_000, now, false), false, "but not again a second later");
  assert.equal(
    shouldDrainNow(now - AUDIT_OUTBOX_DRAIN_INTERVAL_MS, now, false),
    true,
    "once the interval is up it drains again",
  );
  assert.equal(
    shouldDrainNow(0, now, true),
    false,
    "and never while a drain is already in flight — two overlapping requests must not both start one",
  );

  // ── THE DRAIN WRITES WHAT THE CALLER MEANT ───────────────────────────────────────────────────
  //
  // The queued payload is replayed through the SAME mapper the live insert uses, so a defaulted
  // actor or a null entity cannot come out different hours later.
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
  assert.equal(
    undated.attemptedAt,
    new Date(0).toISOString(),
    "and falls back to the epoch, so the landing probe looks at everything rather than nothing",
  );

  // ── THE QUEUE SAYS WHY, IN ONE LINE ──────────────────────────────────────────────────────────
  //
  // 🔴 A SUPABASE REJECTION IS NOT AN `Error` — PostgREST rethrows a plain object, which is exactly
  // how the stack column of app_error_events used to land empty (see persistedStack in log.ts).
  assert.equal(describeQueueError(new Error("boom")), "Error: boom");
  assert.equal(
    describeQueueError({ code: "57014", message: "canceling statement due to statement timeout" }),
    "57014 canceling statement due to statement timeout",
    "a PostgREST rejection must be readable, not '[object Object]'",
  );
  assert.ok(describeQueueError("plain").includes("plain"));
  assert.ok(describeQueueError(undefined).length > 0, "even an undefined cause leaves something readable");
  assert.ok(describeQueueError(new Error("x".repeat(5_000))).length <= 500, "and it stays short");

  // ── THE RETRY PROBES BEFORE IT WRITES ────────────────────────────────────────────────────────
  //
  // A 3-second abort is the CLIENT giving up, not Postgres rolling back. Retrying blind would turn
  // "never lose a row" into "write some rows twice", and /admin/logs would show one act happening
  // two or three times.
  const auditSource = read(AUDIT);
  assert.ok(
    auditSource.includes("auditLogAlreadyLanded"),
    `${AUDIT} must probe for the row before retrying a timed-out insert.`,
  );
  const probeIndex = auditSource.indexOf("auditLogAlreadyLanded(input, attemptedAt)");
  const retryIndex = auditSource.indexOf("insertAuditLog(input, AUDIT_INSERT_RETRY_TIMEOUT_MS)");
  assert.ok(probeIndex > 0 && retryIndex > 0, `${AUDIT} must both probe and retry.`);
  assert.ok(
    probeIndex < retryIndex,
    `${AUDIT} probes AFTER it retries — that is the duplicate the probe exists to prevent.`,
  );
  assert.ok(
    auditSource.includes("queueAuditLog(input, attemptedAt"),
    `${AUDIT} must park a write that failed twice in the outbox. Without it the row is lost, which ` +
      "is the entire defect this change was opened for.",
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
  assert.equal(
    countOf('event: "critical_audit_persistence_failed"'),
    1,
    `${AUDIT} logs critical_audit_persistence_failed more than once per failure.`,
  );
  assert.ok(
    auditSource.includes("throw new AuditPersistenceError"),
    `${AUDIT} must still throw for a REQUIRED audit row. The queue stops the row being lost; it does ` +
      "not decide for the caller that the act may proceed unrecorded.",
  );

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
  // table exists. The table was applied and read back out of pg_class on both projects by hand.
  const migration = read("supabase/migrations/20261023190001_audit_log_outbox.sql");
  assert.ok(migration.includes("create table if not exists public.audit_log_outbox"), "the queue needs its table");
  for (const column of ["payload jsonb", "attempts integer", "last_error", "next_attempt_at", "created_at"]) {
    assert.ok(migration.includes(column), `audit_log_outbox is missing ${column}`);
  }
  assert.ok(
    migration.includes("enable row level security"),
    "audit_log_outbox holds audit rows in waiting — it is service-role only, like audit_logs.",
  );
  assert.ok(
    migration.includes("revoke all on public.audit_log_outbox from anon, authenticated"),
    "a table in `public` is born readable to the browser keys unless the grant is revoked.",
  );

  const outboxSource = read(OUTBOX);
  assert.ok(
    outboxSource.includes("maybeDrainAuditLogOutbox"),
    `${OUTBOX} must expose the opportunistic drain — there is no cron slot for a scheduled one.`,
  );
}
