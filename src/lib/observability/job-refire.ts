import { isProductionRuntime } from "@/config/system-settings";
import { WAIT_FOR_THE_RUN_PARAM } from "@/lib/http/answer-now";
import type { JobHeartbeatProblem } from "@/lib/observability/job-heartbeat-assess";
import { JOB_SCHEDULE_TIMEZONE } from "@/lib/observability/job-schedule";
import { logError, logInfo } from "@/lib/observability/log";
import {
  DAILY_FAN_OUT_PATH,
  DAILY_FAN_OUT_SLUG,
  DAILY_JOB_REFIRE_LATEST_CAIRO_MINUTES,
  DAILY_JOBS,
  dailyJobHeartbeatSlug,
  dailyJobPath,
  dailyJobsSplitIsOn,
} from "@/lib/scheduled-jobs/daily-jobs";
import { assertApiRateLimit, isApiRateLimitError } from "@/lib/security/api-rate-limit";

/**
 * Re-fires a morning job that never reported, ONCE, when it is safe to.
 *
 * WHY IT EXISTS. On 2026-10-16 a deploy replaced the container at 06:37 in the middle of
 * `phoenix-notify-daily`, the morning fan-out (split into one job per schedule on 13 Nov 2026). The
 * job never reported, the sweep noticed at 07:36, and nothing acted: the day's notifications stayed
 * half-sent until a person looked. This is the act.
 *
 * WHAT IT WILL NOT DO, each a deliberate limit:
 *   - It only touches a job named in {@link JOB_REFIRE_POLICIES}. A job is added there only after
 *     its sub-jobs were read for what a second run on the same day does (docs/observability.md,
 *     "Re-firing a stranded job"). Being stranded is never enough on its own.
 *   - It acts on STRANDED only (silence). A job that ran and REPORTED failure is left alone: it
 *     got further than a killed run, and looping on a job that fails every time would be the
 *     duplicate-message incident the old daily fan-out's header warned about.
 *   - Once per Cairo day per job, claimed ATOMICALLY (the rate-limit bucket RPC) before anything is
 *     started, so two sweeps a few seconds apart cannot both fire it. A claim that cannot be made
 *     means nothing is fired.
 *   - Only on the day the fire was missed, and only before the policy's cut-off. A morning job
 *     started at four in the afternoon, or for yesterday, tells people things that are no longer
 *     true.
 *   - Production only, and only when the shared cron secret is present.
 */

export type JobRefirePolicy = {
  /** The cron route that runs the job, called on this server with the shared cron secret. */
  path: string;
  /** Latest Cairo minute-of-day at which a re-fire is still useful (12:00 = 720). */
  latestCairoMinutes: number;
};

/**
 * The morning jobs' re-fire policies, for one position of the `PHOENIX_DAILY_JOBS_SPLIT` switch.
 * `phoenix-notify-daily` held its policy after its sub-jobs were read for a same-day repeat on
 * 2026-10-16 (docs/observability.md, "Re-firing a stranded morning job"): every send is keyed per
 * recipient and day, so a repeat completes what a killed run left and tells nobody twice.
 *   - Switch OFF (what ships): the fan-out runs the jobs, so the fan-out is what is re-fired.
 *   - Switch ON: splitting the bundle changed none of the jobs, so the policy moves with them, job by
 *     job, with the same 12:00 cut-off, to each job's own route.
 * Never both: a re-fire of the fan-out while the switch is on would run nothing (the route is the
 * authorised no-op), and a re-fire of a job's own route while it is off would answer without running.
 */
export function dailyJobRefirePoliciesFor(splitOn: boolean): Record<string, JobRefirePolicy> {
  if (!splitOn) {
    return { [DAILY_FAN_OUT_SLUG]: { latestCairoMinutes: DAILY_JOB_REFIRE_LATEST_CAIRO_MINUTES, path: DAILY_FAN_OUT_PATH } };
  }
  return Object.fromEntries(
    DAILY_JOBS.map((job): [string, JobRefirePolicy] => [
      dailyJobHeartbeatSlug(job.key),
      { latestCairoMinutes: DAILY_JOB_REFIRE_LATEST_CAIRO_MINUTES, path: dailyJobPath(job.key) },
    ]),
  );
}

/** Every re-fire policy for one position of the switch. Pure, so tests can read both. */
export function jobRefirePoliciesFor(splitOn: boolean): Readonly<Record<string, JobRefirePolicy>> {
  return {
    ...dailyJobRefirePoliciesFor(splitOn),
    "phoenix-reconciliation-check": { latestCairoMinutes: 12 * 60, path: "/api/cron/reconciliation-check" },
  };
}

export const JOB_REFIRE_POLICIES: Readonly<Record<string, JobRefirePolicy>> = jobRefirePoliciesFor(dailyJobsSplitIsOn());

/** How long a day's claim lives. Longer than a day on purpose: the key already carries the date. */
const CLAIM_WINDOW_MS = 26 * 60 * 60 * 1000;

export type JobRefireDecision = { day: string; path: string; slug: string };
export type JobRefireSkip = { reason: string; slug: string };

type CairoParts = { day: string; minutes: number };

function cairoParts(date: Date): CairoParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: JOB_SCHEDULE_TIMEZONE,
    year: "numeric",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * Which stranded jobs are eligible to be re-fired right now. Pure: no clock, no database. A job
 * that is not eligible comes back in `skipped` with the reason, so the sweep can say why.
 */
export function decideJobRefires(
  stranded: readonly Pick<JobHeartbeatProblem, "overdueSince" | "slug">[],
  now: Date,
  policies: Readonly<Record<string, JobRefirePolicy>> = JOB_REFIRE_POLICIES,
): { due: JobRefireDecision[]; skipped: JobRefireSkip[] } {
  const due: JobRefireDecision[] = [];
  const skipped: JobRefireSkip[] = [];
  const nowParts = cairoParts(now);
  for (const problem of stranded) {
    const policy = policies[problem.slug];
    if (!policy) continue;
    const overdueMs = problem.overdueSince ? Date.parse(problem.overdueSince) : Number.NaN;
    if (!Number.isFinite(overdueMs)) {
      skipped.push({ reason: "it has no readable overdue time", slug: problem.slug });
      continue;
    }
    const overdueParts = cairoParts(new Date(overdueMs));
    if (overdueParts.day !== nowParts.day) {
      skipped.push({ reason: `the missed run was on ${overdueParts.day}, not today`, slug: problem.slug });
      continue;
    }
    if (nowParts.minutes > policy.latestCairoMinutes) {
      skipped.push({ reason: "it is past the latest time a re-fire is still useful", slug: problem.slug });
      continue;
    }
    due.push({ day: nowParts.day, path: policy.path, slug: problem.slug });
  }
  return { due, skipped };
}

export type JobRefireResult =
  | { outcome: "started"; slug: string }
  | { outcome: "already_refired_today"; slug: string }
  | { outcome: "not_started"; reason: string; slug: string };

export type JobRefireDeps = {
  /** Atomically claims the day's one re-fire. True = this caller owns it. Throws if it cannot say. */
  claim?: (key: string) => Promise<boolean>;
  /** Starts the job. Called after a successful claim; must not make the sweep wait for the job. */
  trigger: (path: string) => void | Promise<void>;
};

async function claimInDatabase(key: string): Promise<boolean> {
  try {
    await assertApiRateLimit({ identifier: key, limit: 1, scope: "job-refire", windowMs: CLAIM_WINDOW_MS });
    return true;
  } catch (error) {
    if (isApiRateLimitError(error)) return false;
    throw error;
  }
}

/**
 * Claims and starts every eligible re-fire. Never throws: the sweep's own verdict must not depend
 * on it, so a failure is returned as `not_started` and logged.
 */
export async function refireStrandedJobs(
  stranded: readonly Pick<JobHeartbeatProblem, "overdueSince" | "slug">[],
  deps: JobRefireDeps,
  now: Date = new Date(),
): Promise<{ results: JobRefireResult[]; skipped: JobRefireSkip[] }> {
  const { due, skipped } = decideJobRefires(stranded, now);
  const results: JobRefireResult[] = [];
  const claim = deps.claim ?? claimInDatabase;
  for (const decision of due) {
    try {
      const owns = await claim(`${decision.slug}:${decision.day}`);
      if (!owns) {
        results.push({ outcome: "already_refired_today", slug: decision.slug });
        continue;
      }
      await deps.trigger(decision.path);
      results.push({ outcome: "started", slug: decision.slug });
      logInfo("A stranded job was re-fired once", {
        labels: { event: "job_refired", job: decision.slug },
      });
    } catch (error) {
      results.push({ outcome: "not_started", reason: error instanceof Error ? error.message : String(error), slug: decision.slug });
      logError("A stranded job could not be re-fired", {
        error,
        labels: { event: "job_refire_failed", job: decision.slug },
      });
    }
  }
  return { results, skipped };
}

/**
 * Calls a cron route on THIS server over loopback with the shared cron secret and reads it to the
 * end, so the run is not cut off when the request that asked for it has been answered. The server
 * binds 0.0.0.0 on PORT (Dockerfile), so 127.0.0.1 always reaches it and no proxy timeout applies.
 * Production only; without the secret the route would refuse it anyway, so it says so instead.
 *
 * It asks the route to WAIT (`?wait=1`). Every re-fired route answers 202 at once for the scheduler,
 * which hangs up at 30 seconds (answer-now.ts); a 202 here would read as a re-fire that worked
 * whatever the run then did, and the status below is the only thing this function reports.
 */
export async function fireCronRouteOnLoopback(path: string): Promise<void> {
  if (!isProductionRuntime()) throw new Error("re-fire is production only");
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is not set, so the cron route would refuse the call");
  const port = process.env.PORT || "8080";
  const waitForTheReport = `${path.includes("?") ? "&" : "?"}${WAIT_FOR_THE_RUN_PARAM}=1`;
  const response = await fetch(`http://127.0.0.1:${port}${path}${waitForTheReport}`, {
    headers: { authorization: `Bearer ${secret}` },
    method: "GET",
    signal: AbortSignal.timeout(6 * 60 * 1000),
  });
  await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
}
