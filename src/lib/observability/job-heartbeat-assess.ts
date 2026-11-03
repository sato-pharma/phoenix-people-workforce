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
  /**
   * Rows with no declaration behind them — a slug that was retired while its heartbeat row stayed.
   *
   * REPORTED, never deleted. `bootstrapJobHeartbeatRows` only ever inserts, and this function
   * iterates DECLARATIONS, so such a row is invisible: never counted in `checked`, never alerted,
   * never cleared. `phoenix-interview-digest` was in exactly that state — created 26 Sep 17:39 and
   * retired 26 Sep 22:43 (its cron-job.org job deleted first, so it never fired once), leaving a
   * row with `last_success_at` NULL for ever. docs/observability.md:368-380 warns about this from
   * the other direction.
   *
   * Not an alert either: a retired job is not a broken job, and paging every Super Admin about one
   * is how an alert channel gets ignored. It rides the sweep's detail line so somebody reading the
   * heartbeat sees it, and the row is removed by hand.
   */
  undeclared: string[];
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

// The first moment this expression is due to fire strictly after `afterMs`. Null when it cannot be
// evaluated. A line comment for the same reason as the note above.
function nextScheduledFire(schedule: string, afterMs: number): Date | null {
  try {
    const expression = CronExpressionParser.parse(schedule.trim(), {
      currentDate: new Date(afterMs),
      tz: JOB_SCHEDULE_TIMEZONE,
    });
    return expression.next().toDate();
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
  // Rows no declaration claims. Computed from the other direction to this loop, which is the whole
  // point: iterating declarations is what made a retired slug's row invisible.
  const declaredSlugs = new Set(declarations.map((declaration) => declaration.slug));
  const undeclared = rows.map((row) => row.slug).filter((slug) => !declaredSlugs.has(slug));
  let checked = 0;

  for (const declaration of declarations) {
    const row = bySlug.get(declaration.slug);
    if (!row) {
      awaitingBootstrap.push(declaration.slug);
      continue;
    }
    checked += 1;

    // The baseline: "since when has anything been watching this job". Normally the row's own
    // `first_seen_at`, but a RESTORED declaration carries `watchingSince` and the later of the two
    // wins — the row outlives a stand-down, so without the floor the restored job is judged against
    // fires that had no scheduler behind them. See the field's note in job-schedule.ts.
    //
    // A `watchingSince` that cannot be parsed, or one in the future, is MISDECLARED and nothing else:
    // both would otherwise leave `hadAChanceToRun` false for ever, so this job would never strand
    // again and its silence would stop meaning anything.
    const rowFirstSeenMs = parseTimestamp(row.firstSeenAt) ?? nowMs;
    const watchingSinceMs = declaration.watchingSince ? parseTimestamp(declaration.watchingSince) : null;
    if (declaration.watchingSince && (watchingSinceMs === null || watchingSinceMs > nowMs)) {
      misdeclared.push({
        detail:
          `${declaration.slug} declares watchingSince "${declaration.watchingSince}", which is ` +
          `${watchingSinceMs === null ? "not a date" : "in the future"} — so its silence could never be judged.`,
        kind: "misdeclared",
        lastSuccessAt: row.lastSuccessAt,
        overdueSince: null,
        slug: declaration.slug,
      });
      continue;
    }
    const firstSeenMs = Math.max(rowFirstSeenMs, watchingSinceMs ?? 0);
    const lastSuccessMs = parseTimestamp(row.lastSuccessAt);
    const lastFailMs = parseTimestamp(row.lastFailAt);
    const failedMostRecently =
      row.lastOutcome === "fail" && lastFailMs !== null && (lastSuccessMs === null || lastFailMs > lastSuccessMs);

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
      if (nowMs > deadline && !coveredByLastSuccess && hadAChanceToRun) {
        overdueSinceMs = deadline;
      } else if (!coveredByLastSuccess && hadAChanceToRun) {
        // A GRACE AT OR ABOVE THE GAP BETWEEN FIRES (owner, 2026-11-03). The test above measures from
        // the LATEST fire, and when grace >= the gap the next fire arrives before that deadline does,
        // so `nowMs > deadline` could never be true: 27 of the 59 declared jobs could never strand,
        // the six pg_cron jobs among them, whatever the silence. Measure from the OLDEST fire nothing
        // has answered instead. A job whose grace is below the gap keeps the deadline above, so its
        // `overdueSince` and everything keyed on it (job-refire, the audit detector) are unchanged.
        // A job that reported a failure is not silent: it falls through to the failing report below,
        // which carries its own error, and that report is just as red.
        const nextFire = nextScheduledFire(schedule, previousFireMs);
        const graceCoversTheGap =
          nextFire !== null && declaration.graceSeconds * 1000 >= nextFire.getTime() - previousFireMs;
        if (graceCoversTheGap && !failedMostRecently) {
          const baselineMs = lastSuccessMs !== null ? lastSuccessMs + CLOCK_SKEW_TOLERANCE_MS : firstSeenMs;
          const oldestUnanswered = nextScheduledFire(schedule, baselineMs);
          const oldestDeadline = oldestUnanswered ? oldestUnanswered.getTime() + declaration.graceSeconds * 1000 : null;
          if (oldestDeadline !== null && nowMs > oldestDeadline) overdueSinceMs = oldestDeadline;
        }
      }
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
    // `undeclared` deliberately does NOT affect health. A retired job's leftover row is tidying, not
    // an incident, and making it unhealthy would page every Super Admin every 15 minutes until
    // somebody deleted a row — which is how an alert channel stops being read.
    healthy: stranded.length === 0 && failing.length === 0 && misdeclared.length === 0,
    misdeclared,
    stranded,
    undeclared,
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
