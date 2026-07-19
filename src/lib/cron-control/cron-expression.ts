import { CronExpressionParser } from "cron-parser";

// Pure cron-expression validation and next-run computation for the cron-control dashboard.
// Deliberately has no knowledge of GCP or other jobs — service.ts wires this up with live data.

export type NextRunsResult =
  | { valid: true; nextRuns: string[] }
  | { valid: false; error: string };

const DEFAULT_PREVIEW_COUNT = 5;

/**
 * A schedule that cron-parser can't produce a next occurrence for (bad syntax, or a
 * day/month combination that can never occur, e.g. "0 0 30 2 *" — Feb 30) is rejected here.
 * This is deliberately the ONLY reachability check: computing "next N runs" and validating
 * are the same operation, so there's no separate bound to keep in sync.
 */
export function computeNextRuns(params: {
  cronExpression: string;
  timeZone: string;
  count?: number;
  from?: Date;
}): NextRunsResult {
  const { cronExpression, timeZone, count = DEFAULT_PREVIEW_COUNT, from } = params;

  if (!isValidTimeZone(timeZone)) {
    return { valid: false, error: `"${timeZone}" is not a recognized time zone.` };
  }

  try {
    const expression = CronExpressionParser.parse(cronExpression.trim(), {
      tz: timeZone,
      currentDate: from ?? new Date(),
    });
    const nextRuns = expression.take(count).map((date) => {
      const iso = date.toISOString();
      if (!iso) throw new Error("Computed run date could not be represented.");
      return iso;
    });
    if (nextRuns.length === 0) {
      return { valid: false, error: "This schedule does not appear to ever fire." };
    }
    return { valid: true, nextRuns };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid cron expression.";
    return { valid: false, error: message };
  }
}

export function validateCronExpression(cronExpression: string, timeZone: string): { valid: true } | { valid: false; error: string } {
  const result = computeNextRuns({ cronExpression, timeZone, count: 1 });
  return result.valid ? { valid: true } : { valid: false, error: result.error };
}

function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function formatNextRunHuman(isoTimestamp: string, timeZone: string): string {
  const date = new Date(isoTimestamp);
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${formatted} (${timeZone})`;
}

export type ScheduleCollision = {
  jobName: string;
  atMinute: string;
};

/**
 * Non-blocking warning helper: flags when a candidate schedule's computed run times land in
 * the same UTC minute as another job's. Mirrors the real 2026-07-17 incident documented in
 * scripts/setup-gcp-cron.sh ("stacked crons at :00 saturated the single serving instance") —
 * a warning, not a hard block, since a rare coincidental overlap is not inherently unsafe.
 */
export function detectScheduleCollisions(
  candidateRuns: readonly string[],
  otherJobs: readonly { jobName: string; runs: readonly string[] }[],
): ScheduleCollision[] {
  const candidateMinutes = new Set(candidateRuns.map(truncateToMinute));
  const collisions: ScheduleCollision[] = [];
  for (const other of otherJobs) {
    for (const run of other.runs) {
      const minute = truncateToMinute(run);
      if (candidateMinutes.has(minute)) {
        collisions.push({ jobName: other.jobName, atMinute: minute });
        break;
      }
    }
  }
  return collisions;
}

function truncateToMinute(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 16); // "2026-07-20T03:36" — drops seconds/ms
}
