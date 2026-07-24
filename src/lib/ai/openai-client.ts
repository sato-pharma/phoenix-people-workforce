import OpenAI from "openai";

import { recordAiCall } from "@/lib/observability/ai-metrics";
import { logError } from "@/lib/observability/log";

type OpenAiEnv = Record<string, string | undefined>;
type ResponseCreateInput = Parameters<OpenAI["responses"]["create"]>[0];

export const OPENAI_EMAIL_DEFAULT_MODEL = "gpt-5.4-nano";
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
export const OPENAI_COPILOT_DEFAULT_MODEL = "gpt-5.4";

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

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    logOpenAiError(context, error);
    return new PhoenixOpenAiError("timeout", "The OpenAI request timed out.", { requestId, status });
  }

  if (error instanceof OpenAI.RateLimitError) {
    logOpenAiError(context, error);
    return new PhoenixOpenAiError(
      code === "insufficient_quota" ? "quota_exceeded" : "rate_limited",
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
        code === "insufficient_quota" ? "quota_exceeded" : "rate_limited",
        messageFrom(error),
        { requestId, status },
      );
    }
    return new PhoenixOpenAiError("failed", messageFrom(error), { requestId, status });
  }

  logOpenAiError(context, error);
  return new PhoenixOpenAiError("failed", messageFrom(error), { requestId, status });
}

function openAiClient(apiKey = process.env.OPENAI_API_KEY?.trim(), timeoutMs = OPENAI_EMAIL_TIMEOUT_MS) {
  if (!apiKey) {
    throw new PhoenixOpenAiError("not_configured", "OPENAI_API_KEY is not configured.");
  }
  return new OpenAI({
    apiKey,
    maxRetries: OPENAI_MAX_RETRIES,
    timeout: timeoutMs,
  });
}

export async function createOpenAiResponseText(params: {
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
}) {
  const model = params.model?.trim() || resolveOpenAiEmailModel();
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
    const { data, request_id: requestId } = await openAiClient(undefined, params.timeoutMs).responses.create(request).withResponse();

    recordAiCall({
      component: "openai_client",
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
      component: "openai_client",
      errorCode: normalized.code,
      latencyMs: Date.now() - startedAt,
      model,
      purpose: params.purpose,
      status: "error",
    });
    throw normalized;
  }
}
