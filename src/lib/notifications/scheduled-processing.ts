
import { runAttendanceIngestionAlert } from "@/lib/attendance/ingestion-health";
import { runAttendanceDigestScheduledProcessing } from "@/lib/attendance/digest-scheduler";
import { getInactiveUsers } from "@/lib/activity/service";
import { supersedeExitedEmployeeDeductionCandidates } from "@/lib/deductions-governance/service";
import {
  processNotificationOutbox,
  reapStaleProcessingOutboxRows,
} from "@/lib/notifications/email";
import { createStepBudget, runStep, summarizeTimings, type StepTiming } from "@/lib/notifications/step-runner";
import { processDeferredDeliveryRetries, processTelegramDeliveryRetries } from "@/lib/notifications/system";
import { processDueProbationReminderEvents } from "@/lib/probation/service";
import { processFeedbackSlaReminders } from "@/lib/probation/intelligence/feedback-sla-reminders";
import { processProbationMilestoneEmails } from "@/lib/probation/intelligence/probation-emails";
import { cleanupStalePendingSosBatches } from "@/lib/sales/source-of-sales-batch-supersede";
import { reapStaleIReports360SyncRuns } from "@/lib/crm/sync";

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
          console.error(e, { tags: { cron: "notification-process-probation-reminders" } });
          return { attempted: 0, failed: 1, processedIds: [] as string[], sent: 0, error: String(e) };
        }),
      budget,
      { fallback: { attempted: 0, failed: 0, processedIds: [] as string[], sent: 0, error: "step timed out" } },
    );
    // State-based DV feedback SLA reminders/escalations (deduped by (DV-Day, state) idempotency key).
    const probationFeedbackSla = await runStep(
      "probation-feedback-sla",
      () =>
        processFeedbackSlaReminders().catch((e: unknown) => {
          console.error(e, { tags: { cron: "notification-process-probation-feedback-sla" } });
          return { scanned: 0, due: 0, escalated: 0, overdue: 0, notificationsEmitted: 0, error: String(e) };
        }),
      budget,
      { fallback: { scanned: 0, due: 0, escalated: 0, overdue: 0, notificationsEmitted: 0, error: "step timed out" } },
    );
    // Day 30/60/75 milestone emails (deduped per case+milestone idempotency key — safe to run often).
    const probationMilestones = await runStep(
      "probation-milestones",
      () =>
        processProbationMilestoneEmails().catch((e: unknown) => {
          console.error(e, { tags: { cron: "notification-process-probation-milestones" } });
          return { scanned: 0, sent: 0, error: String(e) };
        }),
      budget,
      { fallback: { scanned: 0, sent: 0, error: "step timed out" } },
    );
    // Never throws; per-day idempotency key prevents duplicate alerts across runs.
    const attendanceAgent = await runStep("attendance-agent", () => runAttendanceIngestionAlert(), budget);
    // Never throws; draft/sent status guards + unique constraints make every step idempotent,
    // so a missed day or a re-run always safely catches up.
    const attendanceDigest = await runStep("attendance-digest", () => runAttendanceDigestScheduledProcessing(), budget);
    // Never throws; idempotent cleanup of pending deduction warnings for exited employees.
    const exitedDeductions = await runStep("exited-deductions", () => supersedeExitedEmployeeDeductionCandidates(), budget);
    // Never throws; clears Source of Sales batches that died mid-pipeline before reaching 'validated'.
    const staleSosBatches = await runStep("stale-sos-batches", () => cleanupStalePendingSosBatches(), budget);
    const outbox = await runStep(
      "outbox",
      () =>
        processNotificationOutbox(limit).catch((e: unknown) => {
          console.error(e, { tags: { cron: "notification-process-outbox" } });
          return { attempted: 0, failed: 1, processedIds: [] as string[], sent: 0, skipped: 0, error: String(e) };
        }),
      budget,
      { fallback: { attempted: 0, failed: 0, processedIds: [] as string[], sent: 0, skipped: 0, error: "step timed out" } },
    );
    const deferred = await runStep(
      "deferred",
      () =>
        processDeferredDeliveryRetries(limit).catch((e: unknown) => {
          console.error(e, { tags: { cron: "notification-process-deferred" } });
          return { attempted: 0, deferred: 0, sent: 0, skipped: 0, error: String(e) };
        }),
      budget,
      { fallback: { attempted: 0, deferred: 0, sent: 0, skipped: 0, error: "step timed out" } },
    );
    const telegram = await runStep(
      "telegram",
      () =>
        processTelegramDeliveryRetries(limit).catch((e: unknown) => {
          console.error(e, { tags: { cron: "notification-process-telegram" } });
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
      attendanceDigest,
      deferred,
      exitedDeductions,
      inactiveUsers: inactiveUsers?.length ?? 0,
      outbox,
      probationFeedbackSla,
      probationMilestones,
      probationReminders,
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
