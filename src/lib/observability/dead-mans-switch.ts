import { isProductionRuntime } from "@/config/system-settings";
import { describeUnexpectedError } from "@/lib/http/api-errors";
import { recordJobHeartbeat } from "@/lib/observability/job-heartbeat";
import { logWarning } from "@/lib/observability/log";

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

/** The external half: Healthchecks.io. Inert when HEALTHCHECKS_PING_KEY is unset. */
async function pingHealthchecks(jobSlug: string, outcome: DeadMansSwitchOutcome, detail?: string): Promise<void> {
  const key = pingKey();
  if (!key) return;

  const suffix = outcome === "fail" ? "/fail" : "";
  const url = `${pingHost()}/${key}/${encodeURIComponent(jobSlug)}${suffix}?create=1`;

  try {
    await fetch(url, {
      body: detail ? detail.slice(0, MAX_DETAIL_BYTES) : undefined,
      method: "POST",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
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
 * Reports one cron job's outcome to BOTH monitors. Best-effort by design and contract: NEVER
 * throws, never delays or masks the actual cron job's own result — a monitoring outage must not
 * itself become a second incident. No-ops entirely outside production, so this stays inert in
 * dev/staging/CI and never flaps a shared production dashboard with test traffic.
 *
 * TWO BACKENDS, ON PURPOSE, AND NEITHER CAN BLOCK THE OTHER.
 *
 *  - Healthchecks.io, external. Its value is being OUTSIDE this system: it still alerts when
 *    Phoenix itself is the thing that is down. Its free tier holds exactly 20 checks and on
 *    2026-08-30 it was full — `POST /checks/` answered HTTP 403 for the 21st — so a job with no
 *    slot got no coverage at all. Unset key or missing slot, this half simply does nothing.
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
  ]);
}

/**
 * The diagnostic detail for a failed job, from any thrown value.
 *
 * MUST be used instead of `String(error)`. Supabase/PostgREST rejects with a PLAIN OBJECT
 * (`{ message, code, details, hint }`), not an `Error`, so `String(error)` yields the literal
 * `"[object Object]"` — which is what every cron in this repo recorded until 2026-09-03, and it
 * destroys the only diagnostic there is. `phoenix-expense-claims-refresh` failed hourly for
 * three hours reporting exactly that: the heartbeat said `[object Object]`, `app_error_events`
 * held nothing, and Railway carried only the heartbeat sweep echoing the same string back. The
 * real cause — a check-constraint violation naming the column and both amounts — was in the
 * rejected object's `code`/`details` the whole time.
 */
export function failureDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : describeUnexpectedError(error);
}

/**
 * Wraps a cron job body: pings "success" if `run` resolves, pings "fail" (with the error message
 * as diagnostic detail) if it throws — then re-throws unchanged, so the caller's own try/catch,
 * logError, and HTTP status logic are completely undisturbed. Use this when a route's existing
 * throw/no-throw shape already means what it says (most of the 7 routes). For
 * app/api/notifications/daily/route.ts, which deliberately never throws on a PARTIAL sub-job
 * failure (see that route's own comment), call `pingDeadMansSwitch` directly instead so the ping
 * can reflect that nuance.
 */
export async function withDeadMansSwitch<T>(jobSlug: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    await pingDeadMansSwitch(jobSlug, "success");
    return result;
  } catch (error) {
    await pingDeadMansSwitch(jobSlug, "fail", failureDetail(error));
    throw error;
  }
}
