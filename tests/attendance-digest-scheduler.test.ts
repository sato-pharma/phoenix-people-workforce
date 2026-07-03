import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for the weekly-digest scheduler
 * (src/lib/attendance/digest-scheduler.ts) and its wiring into the shared
 * daily scheduled-notification-processing pipeline. Entirely Supabase-backed,
 * so — matching attendance-self-scope.test.ts / attendance-settlement-service
 * .test.ts — these pin the safety contract via source inspection.
 */
export function runAttendanceDigestSchedulerTests() {
  const scheduler = readFileSync("src/lib/attendance/digest-scheduler.ts", "utf8");

  // 1. Never throws — a failure processing one employee's digest must never
  //    block the rest of the shared daily pipeline (same contract as
  //    runAttendanceIngestionAlert in ingestion-health.ts).
  assert.match(
    scheduler,
    /export async function runAttendanceDigestScheduledProcessing[\s\S]*?try \{[\s\S]*?\} catch \(error\) \{[\s\S]*?return \{ autoConfirmed: 0, errors, generated: 0, sent: 0 \};/,
    "the top-level scheduler entry point must catch and never throw",
  );
  assert.match(
    scheduler,
    /errors\.push\(`(generate|send|auto-confirm) /,
    "per-digest failures must be collected as errors, not thrown",
  );

  // 2. A week is only processed once it has fully closed — a digest is a
  //    summary of a COMPLETED week, never a partial/in-progress one.
  assert.match(
    scheduler,
    /function isClosed\(week: SettlementWeek, todayIso: string\): boolean \{\s*return week\.endIso < todayIso;/,
    "a settlement week must be strictly closed (endIso < today) before it is generated or sent",
  );

  // 3. Idempotency: generation and sending must reuse the draft/sent status
  //    guards already proven in digest-service.ts / settlement-service.ts —
  //    the scheduler itself adds no separate dedup logic, so re-running it
  //    (or missing a day) is always safe.
  assert.match(scheduler, /persistSettlementWeekDigests/, "must reuse the existing safe persist function, not a new insert path");
  assert.match(scheduler, /sendDigest\(/, "must reuse the existing draft-guarded sendDigest, not a new update path");
  assert.match(scheduler, /autoConfirmDigest\(/, "must reuse the existing sent-guarded autoConfirmDigest, not a new update path");

  // 4. Auto-confirm only targets digests whose window has actually expired.
  assert.match(
    scheduler,
    /\.eq\("status", "sent"\)\s*\.lte\("auto_confirm_at", new Date\(\)\.toISOString\(\)\)/,
    "auto-confirm must only select sent digests whose auto_confirm_at has passed",
  );

  // 5. Wired into the shared daily pipeline (no dedicated sub-daily cron —
  //    project runs on Vercel Hobby with exactly two crons).
  const scheduledProcessing = readFileSync("src/lib/notifications/scheduled-processing.ts", "utf8");
  assert.match(
    scheduledProcessing,
    /runAttendanceDigestScheduledProcessing/,
    "the weekly-digest scheduler must be called from the shared daily scheduled-processing pipeline",
  );
}
