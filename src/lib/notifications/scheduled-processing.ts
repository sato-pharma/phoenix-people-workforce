
import { runAttendanceIngestionAlert } from "@/lib/attendance/ingestion-health";
import {
  processNotificationOutbox,
  reapStaleProcessingOutboxRows,
} from "@/lib/notifications/email";
import { withEmailPolicySnapshot } from "@/lib/notifications/email-policy-snapshot";
import { assessDrainHealth, readDrainQueueBacklog } from "@/lib/notifications/drain-health";
import { notifyDrainStranded } from "@/lib/notifications/drain-health-alert";
import { createStepBudget, runStep, summarizeTimings, type StepTiming } from "@/lib/notifications/step-runner";
import { processDeferredDeliveryRetries, processPushDeliveryRetries, processTelegramDeliveryRetries } from "@/lib/notifications/system";
import { processDueProbationReminderEvents } from "@/lib/probation/service";
import { cleanupStalePendingSosBatches } from "@/lib/sales/source-of-sales-batch-supersede";
import { logError, logInfo } from "@/lib/observability/log";

// This cron runs many steps serially under the route's `maxDuration = 300`. Each step is
// bounded by a soft per-step cap and a global deadline (see step-runner.ts) so a single
// slow/hung step can no longer block the whole chain and 504 the request at 300s — the
// 2026-07-15 outage. The global deadline sits safely under the 300s request cap; the
// per-step cap is generous for a healthy step (each normally finishes in well under 1s)
// but low enough to bound and expose a pathological one in the per-run timing log.
const STEP_TIMEOUT_MS = 30_000;
const TOTAL_BUDGET_MS = 240_000;

// Overlap guard: on a warm instance (concurrency 40), a run that hasn't finished when the
// next 5-minute tick fires would otherwise pile up and compound CPU pressure. Skip a new
// invocation while a prior one is still in flight. The timestamp guard self-heals: if the
// previous run is older than this (i.e. it was killed mid-flight), we proceed anyway.
const OVERLAP_LOCK_MS = 290_000;
let inFlightStartedAt: number | null = null;

/**
 * Every email the outbox drain resolves reads the same email-policy table, so the whole run shares ONE
 * read of it (10 s at most — see email-policy-snapshot.ts) instead of one per email: the N+1 Sentry
 * reported on GET /api/notifications/process. Nothing outside this run ever sees the shared copy.
 */
export function runScheduledNotificationProcessing(limit = 10) {
  return withEmailPolicySnapshot(() => runNotificationProcessingSteps(limit));
}

async function runNotificationProcessingSteps(limit: number) {
  const enteredAt = Date.now();
  // Same instant as `enteredAt`, for the drain-health probe: "due before this run started" is
  // measured against it, which is what keeps a row inserted mid-run from reading as stranded.
  const runStartedAtIso = new Date(enteredAt).toISOString();
  if (inFlightStartedAt !== null && enteredAt - inFlightStartedAt < OVERLAP_LOCK_MS) {
    // logInfo, not console.warn. The overlap guard DOING ITS JOB is the healthy outcome on a
    // per-minute cron, and console.warn goes to stderr, which Railway reads as an error — so the
    // one thing proving the lock works read as a fault. `labels.event` keeps it searchable.
    logInfo(
      `[cron:process] previous run still in flight (${enteredAt - inFlightStartedAt}ms ago) — skipping this invocation to avoid overlap`,
      { labels: { event: "cron_process_overlap_skipped", job: "phoenix-process-notifications" } },
    );
    return { skipped: true as const, reason: "overlapping-run" as const };
  }
  inFlightStartedAt = enteredAt;

  const budget = createStepBudget({ totalBudgetMs: TOTAL_BUDGET_MS, perStepMs: STEP_TIMEOUT_MS });
  try {
    // Never throws; internally catches and returns 0 on failure (see the function's own try/catch).
    const reaped = await runStep("reap-outbox", () => reapStaleProcessingOutboxRows(), budget);
    const probationReminders = await runStep(
      "probation-reminders",
      () =>
        processDueProbationReminderEvents(limit).catch((e: unknown) => {
          logError("Probation reminder processing step failed", {
            labels: { event: "cron_step_failed", cron: "notification-process-probation-reminders" },
            error: e,
          });
          return { attempted: 0, failed: 1, processedIds: [] as string[], sent: 0, error: String(e) };
        }),
      budget,
      { fallback: { attempted: 0, failed: 0, processedIds: [] as string[], sent: 0, error: "step timed out" } },
    );
    // Retired 2026-08-02 at the owner's request: the DV feedback SLA reminders and the day
    // 30/60/75 probation milestone emails. The attendance alert below is NOT a notification and is
    // deliberately kept — it is the only automated signal that punch data has stopped flowing into
    // payroll. (The exited-employee deduction sweep that used to run here was retired in the C6
    // deductions cutover on 2026-08-30; it superseded rows in the legacy governance
    // `deduction_candidates` table, which nothing reads any more — do not re-add it.)
    // Never throws; per-day idempotency key prevents duplicate alerts across runs.
    const attendanceAgent = await runStep("attendance-agent", () => runAttendanceIngestionAlert(), budget);
    // Never throws; clears Source of Sales batches that died mid-pipeline before reaching 'validated'.
    const staleSosBatches = await runStep("stale-sos-batches", () => cleanupStalePendingSosBatches(), budget);
    const outbox = await runStep(
      "outbox",
      () =>
        processNotificationOutbox(limit).catch((e: unknown) => {
          logError("Notification outbox processing step failed", {
            labels: { event: "cron_step_failed", cron: "notification-process-outbox" },
            error: e,
          });
          return { attempted: 0, failed: 1, processedIds: [] as string[], sent: 0, skipped: 0, error: String(e) };
        }),
      budget,
      { fallback: { attempted: 0, failed: 0, processedIds: [] as string[], sent: 0, skipped: 0, error: "step timed out" } },
    );
    const deferred = await runStep(
      "deferred",
      () =>
        processDeferredDeliveryRetries(limit).catch((e: unknown) => {
          logError("Deferred delivery retry processing step failed", {
            labels: { event: "cron_step_failed", cron: "notification-process-deferred" },
            error: e,
          });
          return { attempted: 0, deferred: 0, sent: 0, skipped: 0, error: String(e) };
        }),
      budget,
      { fallback: { attempted: 0, deferred: 0, sent: 0, skipped: 0, error: "step timed out" } },
    );
    const telegram = await runStep(
      "telegram",
      () =>
        processTelegramDeliveryRetries(limit).catch((e: unknown) => {
          logError("Telegram delivery retry processing step failed", {
            labels: { event: "cron_step_failed", cron: "notification-process-telegram" },
            error: e,
          });
          return { attempted: 0, failed: 1, sent: 0, error: String(e) };
        }),
      budget,
      { fallback: { attempted: 0, failed: 0, sent: 0, error: "step timed out" } },
    );
    const push = await runStep(
      "push",
      () =>
        processPushDeliveryRetries(limit).catch((e: unknown) => {
          logError("Push delivery retry processing step failed", {
            labels: { event: "cron_step_failed", cron: "notification-process-push" },
            error: e,
          });
          return { attempted: 0, failed: 1, sent: 0, error: String(e) };
        }),
      budget,
      { fallback: { attempted: 0, failed: 0, sent: 0, error: "step timed out" } },
    );
    // Compute users inactive for 7+ days — logged for now; full alert notifications are a follow-up.
    // Every drain has now run. A drain that does nothing and a drain with nothing to do report
    // the identical `attempted: 0`, which is why the 2026-08-14 freeze stayed invisible for 13
    // days behind a green cron. This is the one check that tells them apart - see drain-health.ts
    // for why it asserts a black-box invariant rather than counting anything inside the loops.
    const backlog = await runStep("drain-health", () => readDrainQueueBacklog(runStartedAtIso), budget, {
      fallback: { deferred: null, outbox: null, push: null, telegram: null },
    });
    const drainHealth = assessDrainHealth([
      { attempted: outbox?.attempted ?? 0, queue: "outbox", strandedBefore: backlog?.outbox ?? null },
      { attempted: telegram?.attempted ?? 0, queue: "telegram", strandedBefore: backlog?.telegram ?? null },
      { attempted: push?.attempted ?? 0, queue: "push", strandedBefore: backlog?.push ?? null },
      { attempted: deferred?.attempted ?? 0, queue: "deferred", strandedBefore: backlog?.deferred ?? null },
    ]);
    if (!drainHealth.healthy) {
      // ERROR, not warning: mail that a user is waiting on is not being delivered, and the last
      // time this happened nothing said so for 13 days. The route turns this into a dead-man's
      // switch failure too, so it reaches an external monitor and not only the log.
      logError("Notification drain attempted nothing while work was already due - retries are not being delivered", {
        labels: { cron: "notification-process", event: "drain_stranded" },
        context: { stranded: drainHealth.stranded },
      });
      // Best-effort, never throws — see drain-health-alert.ts. In-app + Telegram + push, not email:
      // the drain itself may be the thing not delivering.
      await notifyDrainStranded(drainHealth);
    }

    // The inactive-colleague list used to be computed HERE, on the five-minute tick — ~288 times a
    // day, re-reading up to 60,000 session rows each time — and then written to the log as five
    // names and an ellipsis that nobody received. It is a once-a-day digest now, delivered in-app
    // and on Telegram from app/api/notifications/daily (notifyInactiveUsers).

    const totalMs = Date.now() - enteredAt;
    const timings: StepTiming[] = budget.timings;
    console.info(summarizeTimings(timings, totalMs));

    return {
      skipped: false as const,
      attendanceAgent,
      deferred,
      drainHealth,
      outbox,
      probationReminders,
      push,
      reaped,
      staleSosBatches,
      telegram,
      timings,
      totalMs,
    };
  } finally {
    inFlightStartedAt = null;
  }
}
