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
// Pure, and imports nothing itself, so it adds no dependency to this edge-safe module.
import { redactSecretsFromRoute } from "@/lib/error-monitor/redact-route";
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
 *                    and `log_app_error_threw`, the only two it raises (service.ts, inside
 *                    `logAppError` itself). Those come straight back here, so a single failing
 *                    insert would loop for ever. A `.catch()` cannot stop it, because `logAppError`
 *                    never rejects: it catches internally and logs. Naming those two events is what
 *                    stops it, and it is why this is not the obvious three-liner.
 *
 * 🔴 IT USED TO BE A MODULE-WIDE FLAG, AND THAT FLAG WAS DROPPING OTHER PEOPLE'S ERRORS. Set for
 * the whole duration of one in-flight persist and cleared in a `.finally()`, it closed the door on
 * EVERY error logged while any other error's insert was in the air — not just the monitor's own.
 * On a request path that logs twice in a row the second never reached `app_error_events`: measured
 * 23 Oct 2026, all 109 `audit_persistence_failed` failures logged two lines each and left exactly
 * one row every time. So the table's counts were a FLOOR, not a count, and the dropped line was
 * silent in the only place anyone looks. Blocking the two self-reports by name stops the recursion
 * just as completely and drops nothing else.
 *
 * `logAppError` applies its own production gate (`shouldPersistErrorEvents`) and its own
 * signature-based dedupe, so neither is restated here.
 */
const ERROR_MONITOR_SELF_REPORT_EVENTS = new Set(["app_error_insert_failed", "log_app_error_threw"]);

/**
 * Is this ERROR the error monitor complaining about its own insert? Those, and only those, must not
 * be persisted — persisting them is what loops.
 */
export function isErrorMonitorSelfReport(labels: Record<string, string> | undefined): boolean {
  const event = labels?.event;
  return typeof event === "string" && ERROR_MONITOR_SELF_REPORT_EVENTS.has(event);
}

/**
 * What goes in the row's `stack` column — the CAUSE, whatever shape it was thrown in, with the
 * call site's remaining labels in front of it.
 *
 * 🔴 A SUPABASE REJECTION IS NOT AN `Error`. PostgREST rethrows a plain
 * `{ message, details, hint, code }`, so `error instanceof Error` is false, `error.stack` is
 * undefined, and this column used to land EMPTY — the headline and nothing else. That is exactly how
 * `Failed to read a closing publication drift status` reached `app_error_events` at 06:36 Cairo on
 * 2026-10-23: the real answer was `57014 canceling statement due to statement timeout`, and the row
 * the table kept could not say so. Finding it again took the Postgres log, which keeps days where
 * this table keeps months. `describeThrown` is the same reader `serializeError` already uses for
 * stderr, so the two halves of one ERROR no longer disagree about what happened.
 *
 * The labels LEAD, because `stack` is truncated from the END: the short, always-present part goes
 * first and the long cause takes the loss. A headline cannot carry WHICH line, period, job or
 * source, and that is usually the whole question.
 *
 * Three kinds of label are left out. `service` is on every single line ("phoenix-hr"). `event` is
 * already the row's `route`, so repeating it costs characters truncation would take off the cause.
 * And the four that now have a real COLUMN (see `structuredLogErrorInput`) are better there than
 * in free text, since /admin/error-monitor filters on `hr_id` and renders `role`.
 */
const LABELS_WITH_THEIR_OWN_COLUMN = ["hrId", "hr_id", "role", "loginId", "login_id", "digest"];
const LABELS_LEFT_OUT_OF_THE_STACK = new Set(["service", "event", ...LABELS_WITH_THEIR_OWN_COLUMN]);

/**
 * The label part gets its own ceiling, well under the column's 4,000.
 *
 * The labels lead and `stack` is cut from the end, so without a cap a call site that labels
 * generously would push the cause it was captured for out of the row — trading one lost diagnostic
 * for another. 1,000 is far more than any call site passes.
 */
const MAX_STACK_LABELS_LENGTH = 1000;

export function persistedStack(labels: Record<string, string> | undefined, error: unknown): string | null {
  const parts: string[] = [];
  const extra = labels ? Object.entries(labels).filter(([key]) => !LABELS_LEFT_OUT_OF_THE_STACK.has(key)) : [];
  if (extra.length > 0) {
    // Redacted on the way in. A label carries a share-link token exactly as readily as a path does,
    // and this row is written the moment the error happens — while that token still works.
    // `redactSecretsFromRoute` is documented to run over free text for precisely this reason.
    const rendered = extra.map(([key, value]) => `${key}=${redactSecretsFromRoute(value) ?? value}`).join(" ");
    parts.push(rendered.length > MAX_STACK_LABELS_LENGTH ? `${rendered.slice(0, MAX_STACK_LABELS_LENGTH - 1)}…` : rendered);
  }
  if (error instanceof Error) {
    parts.push(error.stack ?? error.message);
  } else if (error != null) {
    parts.push(describeThrown(error));
  }
  const joined = parts.filter((part) => part != null && part.trim() !== "").join("\n");
  return joined === "" ? null : joined;
}

/** First non-empty label under any of the given spellings. */
function labelValue(labels: Record<string, string> | undefined, ...keys: readonly string[]): string | null {
  if (!labels) return null;
  for (const key of keys) {
    const value = labels[key];
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

/**
 * The whole label → row mapping, pure and exported so a test can read it without Supabase.
 *
 * Nothing else decides what a structured ERROR leaves behind in `app_error_events`. Before the
 * four column mappings below, `hr_id` and `role` were NEVER written by this path: measured on
 * production 2026-10-23, of 2,446 `route_type='structured-log'` rows, ZERO carried either. So a
 * Needs You source timeout recorded that A source had timed out and never which one, for whom, or
 * in what scope — the adapters had to be reconstructed out of the delivered Telegram digests in
 * `notification_events.metadata`.
 *
 * Both spellings of each are accepted because both are in use: measured across the call sites,
 * `hrId` 89 times and `hr_id` 14, `loginId` 9 and `login_id` 1.
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
    stack: persistedStack(labels, error),
    hrId: labelValue(labels, "hrId", "hr_id"),
    role: labelValue(labels, "role"),
    loginId: labelValue(labels, "loginId", "login_id"),
    digest: labelValue(labels, "digest"),
  };
}

function persistErrorEvent(message: string, labels: Record<string, string> | undefined, error: unknown) {
  // The error monitor's own two complaints stay on stderr only — persisting them is what loops.
  // Everything else is persisted, including a second error raised while a first is still in flight.
  if (isErrorMonitorSelfReport(labels)) return;
  void import("@/lib/error-monitor/service")
    .then(({ logAppError }) => logAppError(structuredLogErrorInput(message, labels, error)))
    .catch(() => {
      // Only an import failure can land here; logAppError itself never rejects.
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
