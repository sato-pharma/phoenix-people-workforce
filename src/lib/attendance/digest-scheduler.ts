// Weekly-digest scheduled processing: generate -> send -> auto-confirm.
//
// Piggybacked on the existing daily scheduled-notification-processing cron
// (src/lib/notifications/scheduled-processing.ts) — no dedicated sub-daily
// cron, matching the project's Vercel Hobby two-cron constraint and the same
// pattern already used by runAttendanceIngestionAlert(). Every step is
// idempotent (draft/sent status guards, unique constraints) so running this
// multiple times a day, or missing a day, is always safe to catch up from.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { cairoTodayIso } from "@/lib/attendance/working-days";
import { resolveDigestCycle, tileSettlementWeeks, type SettlementWeek } from "@/lib/attendance/digest-cycle";
import { getDigestSettings } from "@/lib/attendance/digest-recipients";
import { computeSettlementWeekDigests, persistSettlementWeekDigests } from "@/lib/attendance/digest-service";
import { autoConfirmDigest, sendDigest } from "@/lib/attendance/settlement-service";

export type DigestSchedulerResult = {
  generated: number;
  sent: number;
  autoConfirmed: number;
  errors: string[];
};

function weekLabel(week: SettlementWeek): string {
  return `${week.startIso} to ${week.endIso}`;
}

/** A settlement week is ready to generate/send once it has fully closed. */
function isClosed(week: SettlementWeek, todayIso: string): boolean {
  return week.endIso < todayIso;
}

async function generateAndSendClosedWeeks(todayIso: string, cycleAnchorDay: number, errors: string[]) {
  let generated = 0;
  let sent = 0;

  const cycle = resolveDigestCycle(todayIso, cycleAnchorDay);
  const closedWeeks = tileSettlementWeeks(cycle).filter((week) => isClosed(week, todayIso));

  for (const week of closedWeeks) {
    try {
      const { results: digests, skipped } = await computeSettlementWeekDigests(week);
      if (skipped.length > 0) {
        // Never silently dropped: each held employee is reported so someone
        // can fix the underlying data and re-run generation for them.
        for (const skip of skipped) {
          errors.push(`held (bad data) — ${skip.employeeHrId} week ${week.index} (${cycle.cycleKey}): ${skip.reason}`);
        }
      }
      if (digests.length > 0) {
        const { digestIds } = await persistSettlementWeekDigests({ cycleKey: cycle.cycleKey, digests, week });
        generated += digestIds.length;

        for (const digestId of digestIds) {
          try {
            const wasSent = await sendDigest({
              actionUrl: "/employee-portals/attendance",
              digestId,
              weekLabel: weekLabel(week),
            });
            if (wasSent) sent += 1;
          } catch (error) {
            errors.push(`send digest ${digestId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } catch (error) {
      errors.push(`generate week ${week.index} (${cycle.cycleKey}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { generated, sent };
}

async function autoConfirmExpiredDigests(errors: string[]) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select("id")
    .eq("status", "sent")
    .lte("auto_confirm_at", new Date().toISOString());
  if (error) {
    errors.push(`load expired digests: ${error.message}`);
    return 0;
  }

  let autoConfirmed = 0;
  for (const row of (data ?? []) as Array<{ id: number }>) {
    try {
      const result = await autoConfirmDigest(row.id);
      if (result.autoConfirmed.length > 0) autoConfirmed += 1;
    } catch (error) {
      errors.push(`auto-confirm digest ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return autoConfirmed;
}

/**
 * Never throws — a failure in one digest must never block the rest of the
 * shared daily notification-processing pipeline (same contract as
 * runAttendanceIngestionAlert). Errors are collected and returned instead.
 */
export async function runAttendanceDigestScheduledProcessing(): Promise<DigestSchedulerResult> {
  const errors: string[] = [];
  try {
    const settings = await getDigestSettings();
    const todayIso = cairoTodayIso();

    const { generated, sent } = await generateAndSendClosedWeeks(todayIso, settings.cycleAnchorDay, errors);
    const autoConfirmed = await autoConfirmExpiredDigests(errors);

    return { autoConfirmed, errors, generated, sent };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { autoConfirmed: 0, errors, generated: 0, sent: 0 };
  }
}
