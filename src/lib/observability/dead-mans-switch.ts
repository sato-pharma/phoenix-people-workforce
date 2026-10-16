import { isProductionRuntime } from "@/config/system-settings";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { recordJobHeartbeat } from "@/lib/observability/job-heartbeat";
import { logWarning } from "@/lib/observability/log";
import { sentryServerStatus } from "@/lib/observability/sentry-policy";

// An INDEPENDENT, EXTERNAL liveness monitor (Healthchecks.io) for the 8 Cloud Scheduler jobs —
// separate from GCP log-based alerting, on purpose, and since Sentry's retirement (2026-07-31)
// this is the ONLY thing that detects a job that stopped running. On 2026-07-23 three
// scheduler jobs were paused as an emergency stop after a mass-send incident and stayed silently
// paused for ~2 days: Cloud Scheduler showed PAUSED (a state, not an alert), the app's own
// GCP observability never fires because a paused job never even attempts a request, and nothing
// external was watching for the ABSENCE of expected activity. A dead-man's-switch closes exactly
// that gap: it alerts on a ping that DIDN'T arrive, so it still works if this app or its Cloud Run
// service is what's broken or paused.
//
// Uses Healthchecks.io's Ping Key + slug API (https://healthchecks.io/docs/http_api/,
// https://healthchecks.io/docs/slug_urls/): one secret (the project's Ping Key) covers every
// check, addressed by a human-readable slug instead of a per-check UUID that would need to be
// manually created and copied for each of the 7 jobs. `create=1` opts into auto-provisioning
// (https://healthchecks.io/docs/autoprovisioning/, off by default) so the first real ping from
// each job creates its check automatically — inert code ships now; the check appears in the
// Healthchecks dashboard the first time it actually pings after HEALTHCHECKS_PING_KEY is set.
// Auto-provisioned checks default to a 1-day period / 1-hour grace, which is wrong for several of
// these jobs (the */5 outbox drain especially) — see docs/observability.md for the per-job Cron
// schedule + grace values to set by hand afterward; that tuning cannot be done through the ping
// URL itself (Management API or dashboard only).

const PING_TIMEOUT_MS = 5_000;
const MAX_DETAIL_BYTES = 4_000;

function pingHost(): string {
  return (process.env.HEALTHCHECKS_PING_HOST || "https://hc-ping.com").replace(/\/+$/, "");
}

function pingKey(): string | null {
  const trimmed = process.env.HEALTHCHECKS_PING_KEY?.trim();
  return trimmed ? trimmed : null;
}

export type DeadMansSwitchOutcome = "success" | "fail";

/**
 * What one request to Healthchecks can say. `start` is not an outcome: it says only "this run began",
 * and exists in the external half alone - the in-house heartbeat register records how a run ENDED.
 */
type HealthchecksSignal = DeadMansSwitchOutcome | "start";

/** The external half: Healthchecks.io. Inert when HEALTHCHECKS_PING_KEY is unset. */
async function pingHealthchecks(jobSlug: string, outcome: HealthchecksSignal, detail?: string): Promise<void> {
  const key = pingKey();
  if (!key) return;

  const suffix = outcome === "fail" ? "/fail" : outcome === "start" ? "/start" : "";
  const url = `${pingHost()}/${key}/${encodeURIComponent(jobSlug)}${suffix}?create=1`;

  try {
    const response = await fetch(url, {
      body: detail ? detail.slice(0, MAX_DETAIL_BYTES) : undefined,
      method: "POST",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    // 🔴 A REFUSED PING IS A RESOLVED PROMISE, AND THIS RESPONSE WENT UNREAD FOR MONTHS. `fetch`
    // throws on a network failure only, so a 403 (the project is at its check ceiling and will not
    // auto-provision another) or a 404 came back as success and logged NOTHING — which is exactly
    // how `phoenix-brick-move-drain` came to ping every 20 minutes from 2026-10-13 with no check
    // behind it and nothing anywhere saying so (found 2026-10-15, on the owner's audit). Still a
    // WARNING, never an error: the contract below is unchanged, and a monitoring refusal must not
    // page anyone. It only has to be SAYABLE.
    if (!response.ok) {
      logWarning("Dead-man's-switch ping was refused by Healthchecks (non-fatal — the cron job's own result is unaffected)", {
        context: { status: response.status },
        labels: { event: "deadmans_switch_ping_refused", job: jobSlug, outcome, status: response.status },
      });
    }
  } catch (error) {
    // logWarning, not logError: a failed monitoring ping is not an application failure and must
    // never itself page anyone — that would defeat the whole "stays quiet unless something is
    // genuinely wrong" point of a dead-man's switch.
    logWarning("Dead-man's-switch ping failed (non-fatal — the cron job's own result is unaffected)", {
      error,
      labels: { event: "deadmans_switch_ping_failed", job: jobSlug, outcome },
    });
  }
}

/**
 * The third half: Sentry cron monitoring, a check-in per run. Inert unless Sentry is on (production plus a DSN),
 * and it carries the monitor's schedule from the register of scheduled jobs, so Sentry creates the monitor on
 * the job's first check-in. A job the register does not declare sends none and creates nothing. The SDK is reached by dynamic import for the same edge-safety reason as everywhere else.
 */
async function checkInSentry(jobSlug: string, outcome: DeadMansSwitchOutcome): Promise<void> {
  try {
    if (!sentryServerStatus({ appEnv: process.env.APP_ENV, dsn: process.env.SENTRY_DSN }).enabled) return;
    const { captureCronCheckInInSentry } = await import("@/lib/observability/sentry-server");
    captureCronCheckInInSentry(jobSlug, outcome === "success" ? "ok" : "error");
  } catch {
    // A monitoring outage must never become a second incident.
  }
}

/**
 * Reports one cron job's outcome to ALL THREE monitors. Best-effort by design and contract: NEVER
 * throws, never delays or masks the actual cron job's own result — a monitoring outage must not
 * itself become a second incident. No-ops entirely outside production, so this stays inert in
 * dev/staging/CI and never flaps a shared production dashboard with test traffic.
 *
 * THREE BACKENDS, ON PURPOSE, AND NONE CAN BLOCK THE OTHERS (Sentry's check-in joined them 2026-10-16).
 *
 *  - Healthchecks.io, external. Its value is being OUTSIDE this system: it still alerts when
 *    Phoenix itself is the thing that is down. It has a CEILING, and a job past it gets no external
 *    coverage at all: `POST /checks/` answered HTTP 403 for the 21st on 2026-08-30, and the project
 *    held 40 checks on 2026-10-15 with `phoenix-brick-move-drain` unable to auto-provision a 41st —
 *    so treat the number as something to MEASURE (`GET /api/v3/checks/`), never as 20. Unset key or
 *    no slot, this half does nothing; since 2026-10-15 a refusal at least logs a warning.
 *  - `public.job_heartbeats`, in-house. No cap, so every declared job is covered, and it records
 *    the one thing the external switch only ever showed on a dashboard: that a run happened and
 *    REPORTED FAILURE. Swept by /api/cron/job-heartbeat-sweep, which alerts in-app + Telegram.
 *
 * `allSettled`, not `all`: whichever backend is unavailable, the other must still record the run.
 * Both halves already swallow their own errors; this is the belt to that pair of braces.
 */
export async function pingDeadMansSwitch(jobSlug: string, outcome: DeadMansSwitchOutcome, detail?: string): Promise<void> {
  if (!isProductionRuntime()) return;

  await Promise.allSettled([
    recordJobHeartbeat(jobSlug, outcome, detail),
    pingHealthchecks(jobSlug, outcome, detail),
    checkInSentry(jobSlug, outcome),
  ]);
}

/**
 * Tells Healthchecks this run has BEGUN (`/start`). Same contract as `pingDeadMansSwitch`: never
 * throws, inert outside production and without a ping key, external half only.
 *
 * WHY A LONG JOB SENDS ONE. Without it a run a deploy killed halfway and a run that never began look
 * identical - both are just a missing ping. On 2026-10-16 `phoenix-notify-daily` and, almost
 * certainly, `phoenix-crm-integrity-sweep` were each cut off by a container swap, and the dashboard
 * could only say "no ping". With a start signal Healthchecks shows "started, never finished", which
 * points straight at a restart, and it records how long each run takes, so a job creeping toward its
 * grace shows before it trips. It is AWAITED, never fire-and-forget: a start that landed AFTER the
 * run's own success ping would leave the check "started" for good and raise a false alarm.
 *
 * Only for a job whose check is tuned with a grace longer than a normal run (Healthchecks measures
 * the grace from the start), and only for one that always ends in a success or fail ping.
 */
export async function signalDeadMansSwitchStart(jobSlug: string): Promise<void> {
  if (!isProductionRuntime()) return;
  await pingHealthchecks(jobSlug, "start");
}

/**
 * Wraps a cron job body: pings "success" if `run` resolves, pings "fail" (with the error message
 * as diagnostic detail) if it throws — then re-throws unchanged, so the caller's own try/catch,
 * logError, and HTTP status logic are completely undisturbed. Use this when a route's existing
 * throw/no-throw shape already means what it says (most of the 7 routes). For
 * app/api/notifications/daily/route.ts, which deliberately never throws on a PARTIAL sub-job
 * failure (see that route's own comment), call `pingDeadMansSwitch` directly instead so the ping
 * can reflect that nuance.
 *
 * `signalStart: true` sends the `/start` signal first - see `signalDeadMansSwitchStart`.
 */
export async function withDeadMansSwitch<T>(
  jobSlug: string,
  run: () => Promise<T>,
  options: { signalStart?: boolean } = {},
): Promise<T> {
  if (options.signalStart) await signalDeadMansSwitchStart(jobSlug);
  try {
    const result = await run();
    await pingDeadMansSwitch(jobSlug, "success");
    return result;
  } catch (error) {
    await pingDeadMansSwitch(jobSlug, "fail", describeThrown(error));
    throw error;
  }
}
