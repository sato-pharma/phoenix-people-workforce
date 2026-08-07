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

import { getDeployRevision } from "@/lib/observability/deploy-identity";

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
  return { message: String(error) };
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
  } else {
    console.log(line);
  }
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

// Same `x-forwarded-for` convention as requestIp() in src/lib/security/api-rate-limit.ts.
function sourceIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip")?.trim() || null;
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
