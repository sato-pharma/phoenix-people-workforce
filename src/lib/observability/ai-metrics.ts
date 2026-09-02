// Failure signal for AI/LLM calls, visible where this app actually runs.
//
// WAS: a writer for GCP Cloud Monitoring custom metrics, left over from Cloud Run. Production
// moved to Railway, and GCP_PROJECT_ID is not set there — measured 2026-09-02 — so the writer
// returned on its first line. No request, no error, no log, no metric. Every AI call outcome in
// production went nowhere, and the code read as working telemetry the whole time.
//
// That gap is not theoretical. On 2026-09-02 OPENAI_API_KEY in Railway production was found to
// hold a MASKED paste ("sk-..." glued onto the front of the real key and "..." onto the end).
// OpenAI answered 401 and every AI feature failed together — CV extraction, payroll copilot,
// email assist, CRM campaign notes, direct-order invoice extraction, outstation expense notes,
// error-monitor triage. Nothing announced it: each call site catches the failure and degrades to
// "no suggestions", so the UI stayed quiet too, and it surfaced only when a person read the error
// text off a screen. The last known-good signal was days earlier.
//
// NOW: a FAILURE writes one row to app_error_events through logAppError — the single writer
// behind /admin/error-monitor and /admin/system-issues. That table is already deployed, already
// read, already Railway-native, and already has retention. Successes write nothing: this is an
// alarm, not a metrics pipeline, and a row per successful call would bury the failures it exists
// to show.

import { logAppError } from "@/lib/error-monitor/service";

// One entry per distinct call-site family (openai-client.ts covers several consumers behind one
// choke point; the sales AI paths are separate because they hit different providers).
export type AiCallComponent = "openai_client" | "sales_ai_provider" | "sales_normalizer_ai_suggest" | "sales_weekly_ai_verify";

export type AiCallStatus = "success" | "error";

export type AiCallRecord = {
  component: AiCallComponent;
  /** Short fixed label, e.g. "payroll_copilot_parse" — never a request ID or other unbounded value. */
  purpose: string;
  model: string;
  status: AiCallStatus;
  latencyMs: number;
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
};

// Owner rule: human-readable names, never raw codes. These reach a screen someone triages from.
const COMPONENT_LABELS: Record<AiCallComponent, string> = {
  openai_client: "Shared OpenAI client",
  sales_ai_provider: "Sales AI provider",
  sales_normalizer_ai_suggest: "Sales normalizer — AI suggest",
  sales_weekly_ai_verify: "Weekly sales — AI verify",
};

/**
 * How long one component+purpose+code combination stays quiet after reporting once.
 *
 * A dead key does not fail once — aiSuggest batches at 60 rows and loops, so a single click can
 * throw the same error a dozen times, and a scheduled CV sweep far more. Un-throttled, the first
 * real outage would bury /admin/error-monitor under thousands of identical rows, which is its own
 * kind of blindness.
 */
export const FAILURE_THROTTLE_MS = 5 * 60_000;

// Bounded by construction: 4 components x a handful of fixed purposes x a handful of codes.
const lastReportedAt = new Map<string, number>();

export function failureThrottleKey(record: AiCallRecord): string {
  return `${record.component}|${record.purpose}|${record.errorCode ?? ""}`;
}

/**
 * Throttle decision, kept pure (the caller owns the map) so it can be tested without a clock or a
 * module reset. Records the write when it returns true.
 */
export function shouldReportFailure(
  key: string,
  nowMs: number,
  seen: Map<string, number>,
  windowMs: number = FAILURE_THROTTLE_MS,
): boolean {
  const last = seen.get(key);
  if (last !== undefined && nowMs - last < windowMs) return false;

  // Drop entries that can no longer suppress anything, so a long-lived process cannot grow this
  // map without bound if the purpose set ever widens.
  if (seen.size > 100) {
    for (const [existing, at] of seen) if (nowMs - at >= windowMs) seen.delete(existing);
  }

  seen.set(key, nowMs);
  return true;
}

function describeCode(errorCode: string | undefined): string {
  if (!errorCode) return "no error code reported";
  return /^\d{3}$/.test(errorCode) ? `HTTP ${errorCode}` : errorCode;
}

/**
 * Builds the error-monitor row for one AI call, or null when there is nothing to report.
 *
 * Pure and exported so the test can assert the row's shape without writing to the table — the
 * suite runs with production credentials (AGENTS.md §2.1), so a test must never reach the writer.
 */
export function buildAiFailureEvent(record: AiCallRecord): Parameters<typeof logAppError>[0] | null {
  if (record.status !== "error") return null;

  const label = COMPONENT_LABELS[record.component] ?? record.component;
  return {
    // Grouped under one module so an outage that takes every AI feature down at once reads as one
    // story, while the pseudo-route below keeps each feature its own signature (signatureKey is
    // `module_key|route`).
    moduleKey: "ai",
    moduleLabel: "AI",
    route: `/ai/${record.component}/${record.purpose}`,
    routeType: "server-ai",
    source: "server",
    message: `AI call failed — ${label}: ${describeCode(record.errorCode)} (model ${record.model}, ${record.latencyMs}ms)`,
    // No stack: these are upstream HTTP failures, and the useful diagnosis is the code plus which
    // feature it came from, both already above. Never the response body — on a 401 OpenAI echoes
    // a fragment of the key back.
    stack: null,
  };
}

/**
 * Whether a failure row may be written from THIS process.
 *
 * `logAppError` already refuses under `next dev` (shouldPersistErrorEvents), which covers the
 * laptop pointing at production Supabase. This adds the suite gate, which that check does NOT
 * cover: `pnpm run test` runs with `--env-file-if-exists=.env.local`, i.e. holding live
 * production credentials, and more than one test reassigns NODE_ENV to "production" mid-run. Per
 * AGENTS.md §2.1, PHOENIX_TEST_SUITE is the load-bearing flag precisely because it is set once by
 * tests/run-tests.ts and depends on no other test's restore discipline. Read lazily, per call, so
 * module import order cannot matter.
 */
function failureReportingEnabled(): boolean {
  if (process.env.PHOENIX_TEST_SUITE === "1") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

/**
 * Records one AI call's outcome. Fire-and-forget by contract: NEVER throws, and is never awaited
 * by the call it describes — a telemetry failure must not turn a working AI call into a failing
 * one, nor add latency to one the user is waiting on.
 */
export function recordAiCall(record: AiCallRecord): void {
  const event = buildAiFailureEvent(record);
  if (!event) return;
  if (!failureReportingEnabled()) return;
  if (!shouldReportFailure(failureThrottleKey(record), Date.now(), lastReportedAt)) return;

  void logAppError(event).catch(() => {
    // Best-effort by contract. logAppError already swallows its own failures; this is the belt for
    // anything thrown before it gets that far.
  });
}
