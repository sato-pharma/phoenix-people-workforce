import { CronExpressionParser } from "cron-parser";

import {
  JOB_SCHEDULE_TIMEZONE,
  type JobScheduleDeclaration,
} from "@/lib/observability/job-schedule";

/**
 * Pure verdict logic for the in-house dead-man's switch. NOTHING HERE TOUCHES A DATABASE — the IO
 * lives in `job-heartbeat.ts`, and the split is deliberate so `tests/job-heartbeat-register.test.ts`
 * can import this file without dragging in `@/lib/supabase/server`.
 *
 * The whole question this answers: for each declared job, has it reported success recently enough
 * that its silence means nothing yet?
 */

/** One row of `public.job_heartbeats`, already camel-cased by the loader. */
export type JobHeartbeatRow = {
  slug: string;
  firstSeenAt: string;
  lastOutcome: "success" | "fail" | null;
  lastSuccessAt: string | null;
  lastFailAt: string | null;
  lastDetail: string | null;
};

export type JobHeartbeatProblemKind = "stranded" | "failing" | "misdeclared";

export type JobHeartbeatProblem = {
  slug: string;
  kind: JobHeartbeatProblemKind;
  /** A complete human sentence — this is what reaches Telegram, so it must stand alone. */
  detail: string;
  lastSuccessAt: string | null;
  /** For `stranded`: the moment the job became overdue (previous scheduled fire + grace). */
  overdueSince: string | null;
};

export type JobHeartbeatVerdict = {
  healthy: boolean;
  /** How many declared jobs actually had a row to judge. */
  checked: number;
  stranded: JobHeartbeatProblem[];
  failing: JobHeartbeatProblem[];
  misdeclared: JobHeartbeatProblem[];
  /** Declared but with no row yet — the sweeper's bootstrap has not reached them. Not an alert. */
  awaitingBootstrap: string[];
};

/**
 * A job that pings a few seconds BEFORE the cron minute it belongs to (clock skew between
 * cron-job.org, Railway and Postgres) would otherwise read as "never ran for this fire". Lateness
 * is already absorbed by the grace; this absorbs the other direction.
 */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

// The previous moment this expression was due to fire, at or before `now`, in Africa/Cairo.
//
// This is the reason `cron-parser` is used rather than a simpler "expected interval". Several real
// schedules here are windowed — `*/5 5 * * *` fires twelve times inside one hour and is then
// silent for 23 hours by design, and `0 6-21/3 * * *` has a nine-hour overnight gap. An interval
// derived from the average spacing calls both of those stranded every single day.
//
// Returns null when the expression cannot be evaluated, which the caller reports rather than
// swallows — a schedule nobody can evaluate is a job nobody is watching.
//
// LINE COMMENTS, NOT JSDOC, AND DELIBERATELY SO: a cron expression beginning `*/` closes a block
// comment early, which turns the rest of this file into a syntax error. Any comment quoting one of
// these schedules verbatim has to be a `//` comment.
export function previousScheduledFire(schedule: string, now: Date): Date | null {
  try {
    const expression = CronExpressionParser.parse(schedule.trim(), {
      currentDate: now,
      tz: JOB_SCHEDULE_TIMEZONE,
    });
    return expression.prev().toDate();
  } catch {
    return null;
  }
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** "3 hours 12 minutes", for a human reading a Telegram message at 4am. */
export function describeDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes || parts.length === 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(" ");
}

function cairoTimestamp(date: Date): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: JOB_SCHEDULE_TIMEZONE,
  }).format(date)} Cairo`;
}

/**
 * Judge every declared job against its row.
 *
 * A job is STRANDED when a scheduled fire plus its grace has passed and no success has been
 * reported for that fire. A job is FAILING when its most recent report was an explicit failure —
 * it ran and said so, which the external switch only ever showed on a dashboard. Stranded wins
 * when both apply: silence is the more serious of the two, and listing a job twice makes the alert
 * harder to read, not more informative.
 *
 * A job with no row at all is AWAITING BOOTSTRAP, never an alert. The sweeper inserts rows for
 * every declared slug on each run, so this state resolves itself on the first sweep after a new
 * job is declared — and a brand-new job must not page anyone merely for being new.
 */
export function assessJobHeartbeats(params: {
  declarations: readonly JobScheduleDeclaration[];
  now: Date;
  rows: readonly JobHeartbeatRow[];
}): JobHeartbeatVerdict {
  const { declarations, now, rows } = params;
  const nowMs = now.getTime();
  const bySlug = new Map(rows.map((row) => [row.slug, row] as const));

  const stranded: JobHeartbeatProblem[] = [];
  const failing: JobHeartbeatProblem[] = [];
  const misdeclared: JobHeartbeatProblem[] = [];
  const awaitingBootstrap: string[] = [];
  let checked = 0;

  for (const declaration of declarations) {
    const row = bySlug.get(declaration.slug);
    if (!row) {
      awaitingBootstrap.push(declaration.slug);
      continue;
    }
    checked += 1;

    const firstSeenMs = parseTimestamp(row.firstSeenAt) ?? nowMs;
    const lastSuccessMs = parseTimestamp(row.lastSuccessAt);
    const lastFailMs = parseTimestamp(row.lastFailAt);

    let overdueSinceMs: number | null = null;

    if (declaration.kind === "simple") {
      const periodMs = (declaration.periodSeconds ?? 0) * 1000;
      const graceMs = declaration.graceSeconds * 1000;
      if (periodMs <= 0) {
        misdeclared.push({
          detail: `${declaration.slug} is declared as a period check but has no period — nothing is watching it.`,
          kind: "misdeclared",
          lastSuccessAt: row.lastSuccessAt,
          overdueSince: null,
          slug: declaration.slug,
        });
        continue;
      }
      // No success yet: the clock runs from when we started watching, not from epoch.
      const deadline = (lastSuccessMs ?? firstSeenMs) + periodMs + graceMs;
      if (nowMs > deadline) overdueSinceMs = deadline;
    } else {
      const schedule = declaration.schedule ?? "";
      const previousFire = schedule ? previousScheduledFire(schedule, now) : null;
      if (!previousFire) {
        misdeclared.push({
          detail:
            `${declaration.slug} declares the schedule "${schedule}", which cannot be evaluated — ` +
            "so nothing can tell whether it ran.",
          kind: "misdeclared",
          lastSuccessAt: row.lastSuccessAt,
          overdueSince: null,
          slug: declaration.slug,
        });
        continue;
      }
      const previousFireMs = previousFire.getTime();
      const deadline = previousFireMs + declaration.graceSeconds * 1000;
      const coveredByLastSuccess =
        lastSuccessMs !== null && lastSuccessMs >= previousFireMs - CLOCK_SKEW_TOLERANCE_MS;
      // A job that has never reported is only overdue once a fire has come round SINCE we started
      // watching it — otherwise declaring a job alarms the moment the code deploys.
      const hadAChanceToRun = lastSuccessMs !== null || previousFireMs > firstSeenMs;
      if (nowMs > deadline && !coveredByLastSuccess && hadAChanceToRun) overdueSinceMs = deadline;
    }

    if (overdueSinceMs !== null) {
      const since = lastSuccessMs
        ? `last succeeded ${describeDuration(nowMs - lastSuccessMs)} ago`
        : "has never reported a success";
      stranded.push({
        detail:
          `${declaration.slug} ${since}; overdue since ${cairoTimestamp(new Date(overdueSinceMs))} ` +
          `(${describeDuration(nowMs - overdueSinceMs)} late).`,
        kind: "stranded",
        lastSuccessAt: row.lastSuccessAt,
        overdueSince: new Date(overdueSinceMs).toISOString(),
        slug: declaration.slug,
      });
      continue;
    }

    const failedMostRecently =
      row.lastOutcome === "fail" && lastFailMs !== null && (lastSuccessMs === null || lastFailMs > lastSuccessMs);
    if (failedMostRecently) {
      failing.push({
        detail:
          `${declaration.slug} last run REPORTED FAILURE at ${cairoTimestamp(new Date(lastFailMs))}` +
          (row.lastDetail ? ` — ${row.lastDetail}` : "."),
        kind: "failing",
        lastSuccessAt: row.lastSuccessAt,
        overdueSince: null,
        slug: declaration.slug,
      });
    }
  }

  return {
    awaitingBootstrap,
    checked,
    failing,
    healthy: stranded.length === 0 && failing.length === 0 && misdeclared.length === 0,
    misdeclared,
    stranded,
  };
}

/** Human summary — used in the alert body, the audit row and the route's response. */
export function describeJobHeartbeats(verdict: JobHeartbeatVerdict): string {
  if (verdict.healthy) {
    return `All ${verdict.checked} watched job(s) reported on time.`;
  }
  const lines: string[] = [];
  if (verdict.stranded.length) {
    lines.push(`Stranded (${verdict.stranded.length}) — nothing has reported:`);
    lines.push(...verdict.stranded.map((problem) => `  • ${problem.detail}`));
  }
  if (verdict.failing.length) {
    if (lines.length) lines.push("");
    lines.push(`Failing (${verdict.failing.length}) — ran and reported an error:`);
    lines.push(...verdict.failing.map((problem) => `  • ${problem.detail}`));
  }
  if (verdict.misdeclared.length) {
    if (lines.length) lines.push("");
    lines.push(`Misdeclared (${verdict.misdeclared.length}) — the declaration itself is unusable:`);
    lines.push(...verdict.misdeclared.map((problem) => `  • ${problem.detail}`));
  }
  return lines.join("\n");
}

/** Every problem slug, sorted — the idempotency key for the alert is built from this. */
export function strandedJobSlugs(verdict: JobHeartbeatVerdict): string[] {
  return [...verdict.stranded, ...verdict.failing, ...verdict.misdeclared]
    .map((problem) => problem.slug)
    .sort();
}
