
import { runAttendanceIngestionAlert } from "@/lib/attendance/ingestion-health";
import { getInactiveUsers } from "@/lib/activity/service";
import { supersedeExitedEmployeeDeductionCandidates } from "@/lib/deductions-governance/service";
import {
  processNotificationOutbox,
  reapStaleProcessingOutboxRows,
} from "@/lib/notifications/email";
import { createStepBudget, runStep, summarizeTimings, type StepTiming } from "@/lib/notifications/step-runner";
import { processDeferredDeliveryRetries, processPushDeliveryRetries, processTelegramDeliveryRetries } from "@/lib/notifications/system";
import { processDueProbationReminderEvents } from "@/lib/probation/service";
import { cleanupStalePendingSosBatches } from "@/lib/sales/source-of-sales-batch-supersede";
import { reapStaleIReports360SyncRuns } from "@/lib/crm/sync";
import { logError } from "@/lib/observability/log";

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

export async function runScheduledNotificationProcessing(limit = 10) {
  const enteredAt = Date.now();
  if (inFlightStartedAt !== null && enteredAt - inFlightStartedAt < OVERLAP_LOCK_MS) {
    console.warn(
      `[cron:process] previous run still in flight (${enteredAt - inFlightStartedAt}ms ago) — skipping this invocation to avoid overlap`,
    );
    return { skipped: true as const, reason: "overlapping-run" as const };
  }
  inFlightStartedAt = enteredAt;

  const budget = createStepBudget({ totalBudgetMs: TOTAL_BUDGET_MS, perStepMs: STEP_TIMEOUT_MS });
  try {
    // Never throws; internally catches and returns 0 on failure (see the function's own try/catch).
    const reaped = await runStep("reap-outbox", () => reapStaleProcessingOutboxRows(), budget);
    // Never throws; internally catches. Rides this cron because it's the most frequent one — see the
    // 2026-07-05 ireports360-visits-reconcile incident this reaper exists to catch promptly.
    const reapedVisitsSyncRuns = await runStep("reap-visits-sync", () => reapStaleIReports360SyncRuns(), budget);
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
    // 30/60/75 probation milestone emails. The two steps below are NOT notifications and are
    // deliberately kept — the attendance alert is the only automated signal that punch data has
    // stopped flowing into payroll, and the exited-employee sweep is what withdraws pending
    // deduction candidates for people who have already left.
    // Never throws; per-day idempotency key prevents duplicate alerts across runs.
    const attendanceAgent = await runStep("attendance-agent", () => runAttendanceIngestionAlert(), budget);
    // Never throws; idempotent cleanup of pending deduction warnings for exited employees.
    const exitedDeductions = await runStep("exited-deductions", () => supersedeExitedEmployeeDeductionCandidates(), budget);
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
    const inactiveUsers = await runStep("inactive-users", () => getInactiveUsers(7), budget);
    if (inactiveUsers && inactiveUsers.length) {
      console.info(
        `[activity] inactivity digest: ${inactiveUsers.length} user(s) inactive 7+ days — ${inactiveUsers.slice(0, 5).map((u) => u.name).join(", ")}${inactiveUsers.length > 5 ? "…" : ""}`,
      );
    }

    const totalMs = Date.now() - enteredAt;
    const timings: StepTiming[] = budget.timings;
    console.info(summarizeTimings(timings, totalMs));

    return {
      skipped: false as const,
      attendanceAgent,
      deferred,
      exitedDeductions,
      inactiveUsers: inactiveUsers?.length ?? 0,
      outbox,
      probationReminders,
      push,
      reaped,
      reapedVisitsSyncRuns,
      staleSosBatches,
      telegram,
      timings,
      totalMs,
    };
  } finally {
    inFlightStartedAt = null;
  }
}
