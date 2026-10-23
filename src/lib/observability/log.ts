// Minimal single-line-JSON structured logger.
//
// Originally shaped for GCP Cloud Logging, which parses a JSON line into a structured LogEntry
// where `logging.googleapis.com/labels` becomes searchable labels. Since the 2026-08-01 move to
// Railway nothing consumes that namespaced key: Railway's log search is plain text/JSON matching,
// so `labels.event` was effectively unsearchable and the recipes written into
// docs/observability.md stopped working. Labels are now emitted under a plain `labels` key, with
// `event` ALSO promoted to the top level — that is the field every alert and search recipe keys
// on, and one hop is worth not having to remember the nesting.
//
// The severity field is kept as-is: it is a useful convention on any platform, and it is what a
// future log drain would key on. Never pass secrets/PII in message or labels.

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { getDeployRevision } from "@/lib/observability/deploy-identity";
import { clientAddress } from "@/lib/security/client-address";

export type LogSeverity = "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL";

type LogLabels = Record<string, string | number | boolean | null | undefined>;

interface LogOptions {
  labels?: LogLabels;
  error?: unknown;
  /** Extra structured context (must be non-sensitive). */
  context?: Record<string, unknown>;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  if (error == null) return undefined;
  // NOT every throw is an Error. Supabase rethrows a plain { message, details, hint, code }, and
  // `String(error)` on one yields the literal "[object Object]" — which is exactly what
  // phoenix-expense-claims-refresh logged on every failed run from 2026-09-03 02:51 Cairo. That
  // route's own docstring names `railway logs | grep expense_claims_refresh` as the detection that
  // works, so this line silently disarmed the documented diagnosis path.
  return { message: describeThrown(error) };
}

function cleanLabels(labels?: LogLabels): Record<string, string> | undefined {
  if (!labels) return undefined;
  const out: Record<string, string> = { service: "phoenix-hr" };
  for (const [k, v] of Object.entries(labels)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

export function logStructured(severity: LogSeverity, message: string, options: LogOptions = {}) {
  const labels = cleanLabels(options.labels);
  const entry: Record<string, unknown> = {
    severity,
    message,
  };
  // `event` first so it is visible at the head of the line in a log tail, not buried after a
  // stack trace. It is the key every alert recipe and search matches on.
  if (labels?.event) entry.event = labels.event;
  if (labels) entry.labels = labels;
  const revision = getDeployRevision();
  if (revision) entry.revision = revision;
  const err = serializeError(options.error);
  if (err) entry.error = err;
  if (options.context) entry.context = options.context;

  const line = JSON.stringify(entry);
  // ERROR/CRITICAL → stderr (also flagged ERROR by Cloud Run even without JSON parsing).
  if (severity === "ERROR" || severity === "CRITICAL") {
    console.error(line);
    persistErrorEvent(message, labels, options.error);
  } else {
    console.log(line);
  }
}

/**
 * ALSO put an ERROR somewhere that outlives the log stream.
 *
 * Until this existed, every one of the 264 `logError` call sites wrote to stderr and nowhere else.
 * Railway keeps about 40 hours of that — measured 02 Oct 2026, when the oldest line it would return
 * moved from 01 Oct 05:59 to 01 Oct 06:10 over forty minutes — and `app_error_events` did not cover
 * the gap: 77 server rows in seven days, every one an AI-call failure or a statement timeout, with
 * no API-route 500 captured since 2026-08-12. So a daily failure like
 * `{resignation_sla_reminder_failed}` existed only for as long as the stream held it.
 *
 * Three things keep this safe to put on the hot path of every error:
 *
 *   fire-and-forget  the caller is not made to await a database write to log a line, and a rejected
 *                    promise is swallowed below rather than becoming a second, worse failure.
 *   dynamic import   `logAppError` reaches Supabase, and this module is imported by edge-safe code.
 *                    Importing it lazily keeps `log.ts` free of that dependency until an ERROR
 *                    actually happens, which on most requests is never.
 *   no recursion     `logAppError` reports its OWN failures through `logError` — `app_error_insert_failed`
 *                    at service.ts:169 and `log_app_error_threw` at :172. Those come straight back
 *                    here, so a single failing insert would loop for ever. A `.catch()` cannot stop
 *                    it, because `logAppError` never rejects: it catches internally and logs. The
 *                    re-entrancy flag below is the only thing that does, and it is why this is not
 *                    the obvious three-liner.
 *
 * `logAppError` applies its own production gate (`shouldPersistErrorEvents`) and its own
 * signature-based dedupe, so neither is restated here.
 */
let persistingErrorEvent = false;

/**
 * Labels that must NOT be repeated in the stored stack's label block.
 *
 * Four of them have a real column and are mapped onto it below — that is strictly better than text,
 * because /admin/error-monitor filters on `hr_id` and renders `role`. `service` is the constant
 * `cleanLabels` stamps on every entry ("phoenix-hr"), so it is noise in every row.
 *
 * Both spellings of each are accepted because both are in use: measured across the call sites,
 * `hrId` 89 times and `hr_id` 14, `loginId` 9 and `login_id` 1.
 *
 * `event`, `route` and `job` are deliberately NOT in this set even though one of them becomes
 * `route`. The column cannot say WHICH it was, and a reader who sees `route=needs_you_source_timeout`
 * needs to know it was the event name rather than a real path.
 */
const LABELS_NOT_REPEATED_IN_THE_BLOCK = new Set(["service", "hrId", "hr_id", "role", "loginId", "login_id", "digest"]);

/** First non-empty label under any of the given spellings. */
function labelValue(labels: Record<string, string> | undefined, ...keys: readonly string[]): string | null {
  if (!labels) return null;
  for (const key of keys) {
    const value = labels[key];
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

/** Everything that has no column of its own, for the stack's label block. */
function labelsWithoutAColumn(labels: Record<string, string> | undefined): Record<string, string> | null {
  if (!labels) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (LABELS_NOT_REPEATED_IN_THE_BLOCK.has(key)) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The whole label → row mapping, pure and exported so a test can read it without Supabase.
 *
 * Nothing else decides what a structured ERROR leaves behind in `app_error_events`.
 */
export function structuredLogErrorInput(
  message: string,
  labels: Record<string, string> | undefined,
  error: unknown,
) {
  return {
    source: "server" as const,
    message,
    // The most specific identifier the call site gave us, in the order a reader would want it.
    // `event` is always there by convention, so this is rarely null.
    route: labels?.route ?? labels?.job ?? labels?.event ?? null,
    routeType: "structured-log",
    stack: error instanceof Error ? (error.stack ?? null) : null,
    // Everything else the call site labelled. Until this existed only the line above survived, so
    // the row said that SOMETHING timed out and never which source, for whom, in what scope — see
    // LOG_LABELS_SEPARATOR in error-monitor/service.ts for the measurement.
    hrId: labelValue(labels, "hrId", "hr_id"),
    role: labelValue(labels, "role"),
    loginId: labelValue(labels, "loginId", "login_id"),
    digest: labelValue(labels, "digest"),
    logLabels: labelsWithoutAColumn(labels),
  };
}

function persistErrorEvent(message: string, labels: Record<string, string> | undefined, error: unknown) {
  // While one persist is in flight, every ERROR it logs about itself stays on stderr only. That is
  // the right trade: the line is never lost, and the alternative is an unbounded loop.
  if (persistingErrorEvent) return;
  persistingErrorEvent = true;
  void import("@/lib/error-monitor/service")
    .then(({ logAppError }) => logAppError(structuredLogErrorInput(message, labels, error)))
    .catch(() => {
      // Only an import failure can land here; logAppError itself never rejects.
    })
    .finally(() => {
      persistingErrorEvent = false;
    });
}

export const logInfo = (message: string, options?: LogOptions) => logStructured("INFO", message, options);
export const logWarning = (message: string, options?: LogOptions) => logStructured("WARNING", message, options);
export const logError = (message: string, options?: LogOptions) => logStructured("ERROR", message, options);

// GCP Cloud Scheduler jobs from the project retired 2026-08-01 still fire on their old schedule
// (billing closed, not deleted) and will keep hitting these routes with a stale secret until GCP
// garbage-collects the project ~30 days after closure. cron-job.org is the real scheduler and
// authenticates fine, so this specific caller is confirmed noise, not an incident. Logged at INFO
// (not WARNING) so it stays searchable via `event=cron_unauthorized` without paging anyone; any
// other unauthorized caller — brute force, a leaked secret, a genuinely misconfigured scheduler —
// still logs at WARNING.
//
// User-Agent alone is client-controlled (any caller can send `User-Agent: Google-Cloud-Scheduler`),
// so downgrading on that header alone would let a real prober silence its own WARNING. Requiring the
// source IP to also fall in the range Railway observed for this caller (34.116.39.0/24, live-verified
// against Railway's HTTP access log 2026-08-06/07) closes that gap: both signals must match. If GCP
// ever rotates addresses and this range stops matching, the caller just reverts to WARNING — a safe
// failure (noisier logs again), never a silently-widened one.
const KNOWN_STALE_CRON_USER_AGENTS = new Set(["Google-Cloud-Scheduler"]);
const KNOWN_STALE_CRON_IP_PREFIX = "34.116.39.";

// The same address requestIp() in src/lib/security/api-rate-limit.ts keys on (client-address.ts).
function sourceIp(request: Request) {
  return clientAddress(request);
}

/**
 * Log an unauthorized cron/webhook invocation so a spike (brute force / misconfigured
 * scheduler / leaked-secret probing) is detectable via a log-based metric + alert.
 */
export function logCronUnauthorized(job: string, request?: Request) {
  const userAgent = request?.headers.get("user-agent") ?? null;
  const ip = request ? sourceIp(request) : null;
  const isKnownStaleScheduler =
    userAgent != null &&
    KNOWN_STALE_CRON_USER_AGENTS.has(userAgent) &&
    ip != null &&
    ip.startsWith(KNOWN_STALE_CRON_IP_PREFIX);
  logStructured(isKnownStaleScheduler ? "INFO" : "WARNING", `Unauthorized cron invocation: ${job}`, {
    labels: { event: "cron_unauthorized", job },
    context: request
      ? {
          hasAuthHeader: Boolean(request.headers.get("authorization")),
          userAgent,
          ip,
        }
      : undefined,
  });
}
