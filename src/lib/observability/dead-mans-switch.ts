import { isProductionRuntime } from "@/config/system-settings";
import { logWarning } from "@/lib/observability/log";

// An INDEPENDENT, EXTERNAL liveness monitor (Healthchecks.io) for the 7 Cloud Scheduler jobs —
// separate from Sentry cron monitors and GCP log-based alerting, on purpose. On 2026-07-23 three
// scheduler jobs were paused as an emergency stop after a mass-send incident and stayed silently
// paused for ~2 days: Cloud Scheduler showed PAUSED (a state, not an alert), the app's own Sentry/
// GCP observability never fires because a paused job never even attempts a request, and nothing
// external was watching for the ABSENCE of expected activity. A dead-man's-switch closes exactly
// that gap: it alerts on a ping that DIDN'T arrive, so it still works if this app, its Cloud Run
// service, or its own Sentry project is what's broken or paused.
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
 * Pings the external monitor for one cron job. Best-effort by design and contract: NEVER throws,
 * never delays or masks the actual cron job's own result — a Healthchecks outage must not itself
 * become a second incident. No-ops (no network attempt at all) outside production, or whenever
 * HEALTHCHECKS_PING_KEY is unset, so this stays completely inert in dev/staging/CI and never
 * flaps a shared production dashboard with test traffic.
 */
export async function pingDeadMansSwitch(jobSlug: string, outcome: DeadMansSwitchOutcome, detail?: string): Promise<void> {
  if (!isProductionRuntime()) return;
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
    await pingDeadMansSwitch(jobSlug, "fail", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    throw error;
  }
}
