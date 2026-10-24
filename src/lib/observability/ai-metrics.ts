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
// behind /admin/system-audit (formerly /admin/error-monitor and /admin/system-issues). That table is already deployed, already
// read, already Railway-native, and already has retention. Successes write nothing: this is an
// alarm, not a metrics pipeline, and a row per successful call would bury the failures it exists
// to show.

import { logAppError } from "@/lib/error-monitor/service";

// One entry per distinct call-site family (openai-client.ts covers several consumers behind one
// choke point; the sales AI paths are separate because they hit different providers).
// `groq_transcription` is the one entry here that is NOT OpenAI, and deliberately so: the CRM's spoken
// visit comment falls back to Groq's Whisper where the browser has no speech engine (Firefox), on the
// owner's cost ruling of 2026-09-25. It shares this alarm because a dead key fails the same silent way.
export type AiCallComponent =
  // Its own entry: it reads a dispute's whole record and answers questions about it, so a cost or a
  // failure question about the Case Briefing is answered per feature, not per shared helper.
  | "dispute_case_briefing"
  | "groq_transcription"
  | "needs_you_summary"
  | "openai_client"
  // Its own entry rather than the shared choke point, because it is its own feature with its own cost
  // question: one call per place validation, ~128 a day in the field. Measured at roughly $3 a month
  // on the nano tier, and the board is where that is checked rather than assumed.
  //
  // `phoenix_crm_schedule` is the timetable read that seats a customer in a polyclinic (2026-10-09),
  // and it is its own entry for the same reason: a different feature at a different volume — one call
  // per SEATING, not one per visit — so its cost and its failures are answered on their own line.
  | "phoenix_crm_schedule"
  | "phoenix_crm_signboard"
  | "sales_ai_provider"
  | "sales_normalizer_ai_suggest"
  | "sales_weekly_ai_verify";

/**
 * What became of one LEG of a call — not of the call.
 *
 * 🔴 `failed_over` IS THE LEG A LATER PROVIDER RESCUED, AND IT IS NOT AN AI FAILURE. Since the Anthropic
 * failover (2026-10-18) a dead OpenAI account refuses the first leg of every call and Claude answers the
 * same call a second later, and both legs recorded `error` — so on 23 Oct 2026 the board carried 21
 * "AI call failed — Shared OpenAI client: account out of credit" rows for 58 CV reads Claude had answered
 * in full, and they were read as dead extractions. A leg the next provider is about to be asked for is
 * reported as `failed_over`; only the leg nothing follows is a failure.
 */
export type AiCallStatus = "success" | "error" | "failed_over";

/**
 * The ACCOUNT a call was billed to, which is what the out-of-credit alarm names and where its credit is added.
 *
 * 🔴 NEVER INFERRED FROM THE COMPONENT (code review, 19 Oct 2026). Since the Anthropic failover (2026-10-18)
 * one component reaches two accounts — the signboard read asks Claude first and OpenAI second, the shared
 * client and the sales paths the other way round — so a Claude account out of credit paged him to top up
 * OpenAI. Every call site says which leg it ran.
 */
export type AiCallProvider = "anthropic" | "anthropic_backup" | "generic" | "groq" | "openai" | "openrouter";

export type AiCallRecord = {
  component: AiCallComponent;
  provider: AiCallProvider;
  /** Short fixed label, e.g. "payroll_copilot_parse" — never a request ID or other unbounded value. */
  purpose: string;
  model: string;
  status: AiCallStatus;
  latencyMs: number;
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** The account asked next, on a `failed_over` leg — so the row says who rescued it, by name. */
  failedOverTo?: AiCallProvider;
};

/**
 * The account's name as anything a human reads says it. Lives in this light module because it is the one
 * every AI path already imports; `aiQuotaProviderLabel` in the alarm delegates here rather than keeping a
 * second copy (owner rule: human-readable names, never raw codes).
 */
const PROVIDER_LABELS: Record<AiCallProvider, string> = {
  anthropic: "Anthropic",
  anthropic_backup: "Anthropic backup",
  generic: "The AI provider",
  groq: "Groq",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

export function aiProviderLabel(provider: AiCallProvider): string {
  return PROVIDER_LABELS[provider] ?? PROVIDER_LABELS.generic;
}

// Owner rule: human-readable names, never raw codes. These reach a screen someone triages from.
const COMPONENT_LABELS: Record<AiCallComponent, string> = {
  dispute_case_briefing: "Disputes — the case briefing and its questions",
  groq_transcription: "CRM spoken comment — Groq speech to text",
  needs_you_summary: "What needs you — the written summary on the daily board",
  openai_client: "Shared OpenAI client",
  phoenix_crm_schedule: "Phoenix CRM — reading the timetable in a polyclinic photo",
  phoenix_crm_signboard: "Phoenix CRM — reading the signboard in a place photo",
  sales_ai_provider: "Sales AI provider",
  sales_normalizer_ai_suggest: "Sales normalizer — AI suggest",
  sales_weekly_ai_verify: "Weekly sales — AI verify",
};

/**
 * How long one component+purpose+code combination stays quiet after reporting once.
 *
 * A dead key does not fail once — aiSuggest batches at 60 rows and loops, so a single click can
 * throw the same error a dozen times, and a scheduled CV sweep far more. Un-throttled, the first
 * real outage would bury /admin/system-audit under thousands of identical rows, which is its own
 * kind of blindness.
 */
export const FAILURE_THROTTLE_MS = 5 * 60_000;

// Bounded by construction: 4 components x a handful of fixed purposes x a handful of codes.
const lastReportedAt = new Map<string, number>();

export function failureThrottleKey(record: AiCallRecord): string {
  // The account too: a dead Claude account must not hide behind a dead OpenAI one on the same feature.
  // And the outcome, or the hourly rescued leg would suppress the real failure of the same feature,
  // account and code for five minutes — the one row that needed to be read.
  return `${record.status}|${record.provider}|${record.component}|${record.purpose}|${record.errorCode ?? ""}`;
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

/**
 * The error code every AI path reports when the provider account has run out of credit — the one
 * failure that no retry, no wait and no code change fixes; only a human topping up the account.
 * `openai-client.ts` already emitted this spelling; the raw-fetch paths now do too
 * (aiErrorCodeForResponse), so the alarm below keys on ONE string.
 */
export const AI_QUOTA_EXHAUSTED_CODE = "quota_exceeded";

/**
 * OpenAI answers HTTP 429 for two unrelated problems: a per-minute rate limit (clears on its own)
 * and an exhausted quota — out of credit (never clears on its own). Only the body tells them apart.
 */
export function isQuotaExhaustedBody(rawBody: string): boolean {
  if (rawBody.toLowerCase().includes("insufficient_quota")) return true;
  try {
    const j = JSON.parse(rawBody) as { error?: { code?: string; type?: string; message?: string } };
    const tag = `${j?.error?.code ?? ""} ${j?.error?.type ?? ""}`.toLowerCase();
    if (tag.includes("insufficient_quota") || tag.includes("billing")) return true;
    const msg = String(j?.error?.message ?? "").toLowerCase();
    return msg.includes("quota") || msg.includes("billing");
  } catch { return false; }
}

/** The errorCode a raw-fetch AI path records for a non-OK response. */
export function aiErrorCodeForResponse(status: number, rawBody: string): string {
  return status === 429 && isQuotaExhaustedBody(rawBody) ? AI_QUOTA_EXHAUSTED_CODE : String(status);
}

/**
 * Whether this call means the AI account is out of credit — the case that pages a human.
 *
 * A rescued leg still pages: the user got their answer from the other provider, but the account is just as
 * empty and only a top-up ends it. That is why this asks "not a success" rather than "an error".
 */
export function isQuotaExhaustedRecord(record: AiCallRecord): boolean {
  return record.status !== "success" && record.errorCode === AI_QUOTA_EXHAUSTED_CODE;
}

function describeCode(errorCode: string | undefined): string {
  if (errorCode === AI_QUOTA_EXHAUSTED_CODE) return "account out of credit (quota exhausted)";
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
  if (record.status === "success") return null;

  const label = COMPONENT_LABELS[record.component] ?? record.component;
  const rescued = record.status === "failed_over";
  return {
    // Grouped under one module so an outage that takes every AI feature down at once reads as one
    // story, while the pseudo-route below keeps each feature its own signature (signatureKey is
    // `module_key|route`).
    moduleKey: "ai",
    moduleLabel: "AI",
    // A rescued leg gets its OWN signature, never the feature's failure signature: on the board the two
    // must never group together, or an hourly by-design failover and a real outage of the same feature
    // read as one story again — the mistake this whole status exists to end.
    route: rescued ? `/ai/${record.component}/${record.purpose}/failed-over` : `/ai/${record.component}/${record.purpose}`,
    routeType: rescued ? "server-ai-failover" : "server-ai",
    source: "server",
    message: rescued
      // Never "the call was answered": this row is written when the next account is ASKED, and if that
      // one fails too it writes its own failure row. This says what is known at this moment and no more.
      ? `AI call failed over to ${aiProviderLabel(record.failedOverTo ?? "generic")} — ${label}: ${aiProviderLabel(record.provider)} said ${describeCode(record.errorCode)} (model ${record.model}, ${record.latencyMs}ms), so the same call went to ${aiProviderLabel(record.failedOverTo ?? "generic")}.`
      : `AI call failed — ${label}: ${describeCode(record.errorCode)} (model ${record.model}, ${record.latencyMs}ms)`,
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
  // Out of credit is the one AI failure only a human can end, and on 2026-09-18 it sat in this
  // table unread. Page the owner too (in-app + Telegram, once a day — ai-quota-alert.ts). Loaded
  // lazily so this light module does not pull the notification stack into every AI call site.
  if (isQuotaExhaustedRecord(record)) {
    void import("@/lib/notifications/ai-quota-alert")
      .then((alert) => alert.notifyAiQuotaExhausted(record))
      .catch(() => {
        // Best-effort by contract, like the row below.
      });
  }
  if (!shouldReportFailure(failureThrottleKey(record), Date.now(), lastReportedAt)) return;

  void logAppError(event).catch(() => {
    // Best-effort by contract. logAppError already swallows its own failures; this is the belt for
    // anything thrown before it gets that far.
  });
}
