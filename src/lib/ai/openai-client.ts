import OpenAI from "openai";

import {
  AnthropicRequestError,
  callAnthropicMessages,
  hasAnthropicApiKey,
  resolveAnthropicModel,
} from "@/lib/ai/anthropic-fallback";
import { recordAiCall, type AiCallComponent } from "@/lib/observability/ai-metrics";
import { logError } from "@/lib/observability/log";

type OpenAiEnv = Record<string, string | undefined>;
type ResponseCreateInput = Parameters<OpenAI["responses"]["create"]>[0];

// The cheap tier, named after the TIER rather than after one of its consumers. It stopped being
// only the email default on 2026-08-27: CV extraction's text route reads on it too, and a constant
// called "email" is not something recruitment should have to import to say "the cheap model".
// $0.20/$1.25 per million input/output tokens, against gpt-5.4's $2.50/$15.00.
export const OPENAI_NANO_MODEL = "gpt-5.4-nano";
export const OPENAI_EMAIL_DEFAULT_MODEL = OPENAI_NANO_MODEL;
export const OPENAI_EMAIL_TIMEOUT_MS = 25_000;
export const OPENAI_MAX_RETRIES = 1;
export const OPENAI_ROUTE_BUDGET_MS = 60_000;
export const OPENAI_EMAIL_MAX_OUTPUT_TOKENS = 4_096;

// Deliberately its OWN tier, not the email nano default: parsing a CEO's free-
// text payroll instructions (resolving names against a 100+ person roster,
// splitting compound clauses, inferring intent) is a much harder task than
// drafting a short email, and this call happens a handful of times per
// payroll run — not per-email volume — so accuracy is worth far more than
// speed/cost here.
// The strong tier, named after the TIER for the reason the nano constant above gives: the nightly
// signboard reader is not a copilot and should not have to import a copilot constant to say "the
// model that can actually read a faded board".
export const OPENAI_STRONG_MODEL = "gpt-5.4";
export const OPENAI_COPILOT_DEFAULT_MODEL = OPENAI_STRONG_MODEL;

export function resolveOpenAiCopilotModel(env: OpenAiEnv = process.env) {
  return env.OPENAI_COPILOT_MODEL?.trim() || env.OPENAI_MODEL?.trim() || OPENAI_COPILOT_DEFAULT_MODEL;
}

export type PhoenixOpenAiErrorCode =
  | "auth_failed"
  | "failed"
  | "not_configured"
  | "quota_exceeded"
  | "rate_limited"
  | "timeout";

export class PhoenixOpenAiError extends Error {
  code: PhoenixOpenAiErrorCode;
  requestId?: string;
  status?: number;

  constructor(
    code: PhoenixOpenAiErrorCode,
    message: string,
    options: { requestId?: string; status?: number } = {},
  ) {
    super(message);
    this.name = "PhoenixOpenAiError";
    this.code = code;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

export function resolveOpenAiEmailModel(env: OpenAiEnv = process.env) {
  return env.OPENAI_EMAIL_MODEL?.trim() || env.OPENAI_MODEL?.trim() || OPENAI_EMAIL_DEFAULT_MODEL;
}

export function hasOpenAiApiKey(env: OpenAiEnv = process.env) {
  return Boolean(env.OPENAI_API_KEY?.trim());
}

// Which provider answers. `AI_PROVIDER=openai|anthropic` pins one; anything else (or unset) is "auto":
// OpenAI first, Anthropic as the second resort once OpenAI says its account is dead.
export type AiProviderMode = "anthropic" | "auto" | "openai";
export type AiProviderName = "anthropic" | "openai";

export function resolveAiProviderMode(env: OpenAiEnv = process.env): AiProviderMode {
  const raw = env.AI_PROVIDER?.trim().toLowerCase();
  return raw === "openai" || raw === "anthropic" ? raw : "auto";
}

/**
 * Whether ANY AI provider is configured — the gate every feature asks before it offers AI. This is the
 * answer to "is AI available", which `hasOpenAiApiKey` stopped being the day Anthropic became a second
 * provider (2026-10-18): a feature gated on the OpenAI key alone would have switched itself off with
 * a perfectly good Anthropic key sitting beside it.
 */
export function hasAiApiKey(env: OpenAiEnv = process.env) {
  const mode = resolveAiProviderMode(env);
  if (mode === "openai") return hasOpenAiApiKey(env);
  if (mode === "anthropic") return hasAnthropicApiKey(env);
  return hasOpenAiApiKey(env) || hasAnthropicApiKey(env);
}

// OpenAI answering "out of credit" or "bad key" does not heal on its own, so once it has said so the
// next calls go straight to Anthropic instead of each paying for a failed OpenAI round trip first. The
// window is per process and short on purpose: a top-up is noticed within ten minutes with no deploy.
export const OPENAI_UNAVAILABLE_WINDOW_MS = 10 * 60_000;
let openAiUnavailableUntilMs = 0;

export function noteOpenAiUnavailable(nowMs = Date.now()) {
  openAiUnavailableUntilMs = nowMs + OPENAI_UNAVAILABLE_WINDOW_MS;
}

export function resetOpenAiAvailability() {
  openAiUnavailableUntilMs = 0;
}

// Read by the sales AI paths (src/lib/sales/ai/provider.ts), which make their own raw calls but share this
// memory: once any caller has learned OpenAI's account is dead, every other caller skips the doomed attempt.
export function isOpenAiUnavailable(nowMs = Date.now()) {
  return nowMs < openAiUnavailableUntilMs;
}

/** The providers to try, in order. Only an environment with BOTH keys ever gets a second entry. */
export function planAiProviders(
  env: OpenAiEnv = process.env,
  nowMs = Date.now(),
  unavailableUntilMs = openAiUnavailableUntilMs,
): AiProviderName[] {
  const mode = resolveAiProviderMode(env);
  if (mode === "openai") return ["openai"];
  if (mode === "anthropic") return ["anthropic"];
  const openAi = hasOpenAiApiKey(env);
  const anthropic = hasAnthropicApiKey(env);
  if (!anthropic) return ["openai"];
  if (!openAi) return ["anthropic"];
  return nowMs < unavailableUntilMs ? ["anthropic", "openai"] : ["openai", "anthropic"];
}

// The two failures that mean the ACCOUNT is dead — a retry, a wait or another model would not help, but
// another provider would. A timeout or a rate limit stays with the provider that gave it.
export function shouldFailOverToNextProvider(code: PhoenixOpenAiErrorCode) {
  return code === "quota_exceeded" || code === "auth_failed";
}

export function sanitizeOpenAiLogMessage(message: string) {
  return message
    .replace(/sk-[a-zA-Z0-9_-]{8,}/g, "sk-***")
    .replace(/Bearer\s+[^\s"'`]+/gi, "Bearer ***");
}

function requestIdFrom(error: unknown) {
  return typeof error === "object" && error !== null && "request_id" in error
    ? String((error as { request_id?: unknown }).request_id ?? "")
    : undefined;
}

function statusFrom(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

function codeFrom(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;
}

function typeFrom(error: unknown) {
  return typeof error === "object" && error !== null && "type" in error
    ? String((error as { type?: unknown }).type ?? "")
    : undefined;
}

// 🔴 OUT OF CREDIT IS NOT ALWAYS `code: "insufficient_quota"`. On 18 Oct 2026 the account answered
// every completion with HTTP 429, `code: "credit_balance_exhausted"` and `type: "insufficient_quota"`
// ("You have no credits remaining"). Read by its code alone that was a plain rate limit, so nothing
// failed over to Anthropic and the out-of-credit alarm stayed quiet while every AI feature was down.
export function isOpenAiOutOfCredit(code: string | undefined, type: string | undefined) {
  return code === "insufficient_quota" || code === "credit_balance_exhausted" || type === "insufficient_quota";
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "unknown OpenAI error";
}

function logOpenAiError(context: string, error: unknown) {
  const requestId = requestIdFrom(error);
  const status = statusFrom(error);
  const detail = sanitizeOpenAiLogMessage(messageFrom(error));
  // Never pass the raw `error` object to logError here: its serializeError() reads
  // error.message/error.stack directly, bypassing sanitizeOpenAiLogMessage entirely and
  // re-leaking the API key that `detail` above just redacted. A request/timeout/rate-limit
  // error never has a useful stack anyway (it's a network/HTTP failure, not a code defect) —
  // requestId/status/code in labels plus the sanitized message is the full diagnostic value.
  logError(`OpenAI request failed: ${detail}`, {
    labels: { event: "openai_request_failed", context, status: status ?? null, requestId: requestId ?? null },
  });
}

export function normalizeOpenAiError(error: unknown, context = "request") {
  if (error instanceof PhoenixOpenAiError) return error;

  const requestId = requestIdFrom(error);
  const status = statusFrom(error);
  const code = codeFrom(error);
  const outOfCredit = isOpenAiOutOfCredit(code, typeFrom(error));

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    logOpenAiError(context, error);
    return new PhoenixOpenAiError("timeout", "The OpenAI request timed out.", { requestId, status });
  }

  if (error instanceof OpenAI.RateLimitError) {
    logOpenAiError(context, error);
    return new PhoenixOpenAiError(
      outOfCredit ? "quota_exceeded" : "rate_limited",
      messageFrom(error),
      { requestId, status },
    );
  }

  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    logOpenAiError(context, error);
    return new PhoenixOpenAiError("auth_failed", messageFrom(error), { requestId, status });
  }

  if (error instanceof OpenAI.APIError) {
    logOpenAiError(context, error);
    if (status === 401 || status === 403) {
      return new PhoenixOpenAiError("auth_failed", messageFrom(error), { requestId, status });
    }
    if (status === 429) {
      return new PhoenixOpenAiError(
        outOfCredit ? "quota_exceeded" : "rate_limited",
        messageFrom(error),
        { requestId, status },
      );
    }
    return new PhoenixOpenAiError("failed", messageFrom(error), { requestId, status });
  }

  logOpenAiError(context, error);
  return new PhoenixOpenAiError("failed", messageFrom(error), { requestId, status });
}

function openAiClient(
  apiKey = process.env.OPENAI_API_KEY?.trim(),
  timeoutMs = OPENAI_EMAIL_TIMEOUT_MS,
  maxRetries = OPENAI_MAX_RETRIES,
) {
  if (!apiKey) {
    throw new PhoenixOpenAiError("not_configured", "OPENAI_API_KEY is not configured.");
  }
  return new OpenAI({
    apiKey,
    maxRetries,
    timeout: timeoutMs,
  });
}

export type CreateResponseTextParams = {
  // A plain string (the common case — text-only prompts) or a structured content-parts
  // array (role + input_text/input_image parts) for multimodal calls, e.g. CV extraction's
  // scanned-image path (src/lib/recruitment/cv-extraction.ts). Reuses the SDK's own type
  // rather than hand-rolling one, so it never drifts from what the installed `openai`
  // package actually accepts.
  input: ResponseCreateInput["input"];
  instructions: string;
  maxOutputTokens?: number;
  model?: string;
  purpose: string;
  /**
   * Which component this call belongs to on the AI telemetry board and the out-of-credit alarm.
   *
   * Defaults to `"openai_client"`, which every existing caller keeps. A caller that is its own
   * feature — the Needs You written summary, say — passes its own so a cost or failure question
   * can be answered per feature rather than per shared helper, and so the out-of-credit alert can
   * name the right account.
   */
  component?: AiCallComponent;
  reasoning?: ResponseCreateInput["reasoning"];
  text: NonNullable<ResponseCreateInput["text"]>;
  /**
   * Overrides the default (email-nano-tier) request timeout — OPENAI_EMAIL_TIMEOUT_MS (25s)
   * is calibrated for the fast/cheap default model and a "high" effort gpt-5.4 call routinely
   * exceeds it (owner report, 2026-07-22: the email-template AI Assist's first real call
   * timed out after the model upgrade). Any caller passing a stronger model + higher
   * reasoning effort should pass a longer timeout explicitly (e.g. OPENAI_ROUTE_BUDGET_MS,
   * previously declared but never actually wired into a client timeout anywhere).
   */
  timeoutMs?: number;
  /**
   * Overrides OPENAI_MAX_RETRIES for ONE call. The SDK retries a timed-out request with the same timeout,
   * so a caller that budgets its own deadline (`timeoutMs` IS the budget) gets twice the budget unless it
   * passes 0: the signboard read at the door budgeted 8 s and waited 16.4 s, five times in three days.
   */
  maxRetries?: number;
};

/**
 * One AI text call, answered by whichever provider `planAiProviders` names first and — only when that
 * provider's ACCOUNT is dead (out of credit, key rejected) — by the next. The name predates Anthropic and
 * is kept: renaming it would touch every AI feature and a dozen source-pinning tests for no behaviour.
 * What comes back is the same `{ model, outputText, requestId }` whichever provider answered.
 */
export async function createOpenAiResponseText(params: CreateResponseTextParams) {
  const requestedModel = params.model?.trim() || resolveOpenAiEmailModel();
  const plan = planAiProviders();

  for (const [index, provider] of plan.entries()) {
    try {
      return provider === "anthropic"
        ? await runAnthropicResponse(params, requestedModel)
        : await runOpenAiResponse(params, requestedModel);
    } catch (error) {
      const failure = normalizeOpenAiError(error, params.purpose);
      if (provider === "openai" && shouldFailOverToNextProvider(failure.code) && hasAnthropicApiKey()) {
        noteOpenAiUnavailable();
      }
      if (index === plan.length - 1 || !shouldFailOverToNextProvider(failure.code)) throw failure;
    }
  }

  // Unreachable: `plan` is never empty and its last entry always throws above. Present for the compiler.
  throw new PhoenixOpenAiError("failed", "No AI provider was attempted.");
}

async function runAnthropicResponse(params: CreateResponseTextParams, requestedModel: string) {
  const component = params.component ?? "openai_client";
  const model = resolveAnthropicModel(requestedModel);
  const startedAt = Date.now();

  try {
    if (!hasAnthropicApiKey()) {
      throw new PhoenixOpenAiError("not_configured", "ANTHROPIC_API_KEY is not configured.");
    }
    const reply = await callAnthropicMessages({
      format: params.text.format,
      input: params.input,
      instructions: params.instructions,
      maxOutputTokens: params.maxOutputTokens ?? OPENAI_EMAIL_MAX_OUTPUT_TOKENS,
      maxRetries: params.maxRetries ?? OPENAI_MAX_RETRIES,
      model,
      timeoutMs: params.timeoutMs ?? OPENAI_EMAIL_TIMEOUT_MS,
    });

    recordAiCall({
      component,
      inputTokens: reply.inputTokens,
      latencyMs: Date.now() - startedAt,
      model: reply.model,
      outputTokens: reply.outputTokens,
      purpose: params.purpose,
      status: "success",
    });

    return { model: reply.model, outputText: reply.outputText, requestId: reply.requestId };
  } catch (error) {
    const normalized = normalizeAnthropicError(error, params.purpose);
    recordAiCall({
      component,
      errorCode: normalized.code,
      latencyMs: Date.now() - startedAt,
      model,
      purpose: params.purpose,
      status: "error",
    });
    throw normalized;
  }
}

// The Anthropic twin of `normalizeOpenAiError`: one PhoenixOpenAiError out, the key redacted from what
// is logged, and nothing but status / request id / code in the labels.
function normalizeAnthropicError(error: unknown, context: string) {
  if (error instanceof PhoenixOpenAiError) return error;
  const failure = error instanceof AnthropicRequestError ? error : null;
  const detail = sanitizeOpenAiLogMessage(messageFrom(error));
  logError(`Anthropic request failed: ${detail}`, {
    labels: {
      event: "anthropic_request_failed",
      context,
      status: failure?.status ?? null,
      requestId: failure?.requestId ?? null,
    },
  });
  return new PhoenixOpenAiError(failure?.code ?? "failed", detail, {
    requestId: failure?.requestId,
    status: failure?.status,
  });
}

async function runOpenAiResponse(params: CreateResponseTextParams, model: string) {
  const component = params.component ?? "openai_client";
  const startedAt = Date.now();

  try {
    const request = {
      input: params.input,
      instructions: params.instructions,
      max_output_tokens: params.maxOutputTokens ?? OPENAI_EMAIL_MAX_OUTPUT_TOKENS,
      model,
      reasoning: params.reasoning ?? { effort: "low" },
      store: false,
      text: params.text,
    } satisfies ResponseCreateInput;
    const { data, request_id: requestId } = await openAiClient(undefined, params.timeoutMs, params.maxRetries).responses.create(request).withResponse();

    recordAiCall({
      component,
      inputTokens: data.usage?.input_tokens,
      latencyMs: Date.now() - startedAt,
      model,
      outputTokens: data.usage?.output_tokens,
      purpose: params.purpose,
      status: "success",
    });

    return {
      model,
      outputText: data.output_text ?? "",
      requestId: requestId || (data as { _request_id?: string })._request_id,
    };
  } catch (error) {
    const normalized = normalizeOpenAiError(error, params.purpose);
    recordAiCall({
      component,
      errorCode: normalized.code,
      latencyMs: Date.now() - startedAt,
      model,
      purpose: params.purpose,
      status: "error",
    });
    throw normalized;
  }
}
