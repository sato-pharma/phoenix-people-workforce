// Shared AI provider resolution + failover + a single JSON chat helper for the Sales module.
//
// The first provider is OpenAI-compatible (/chat/completions). Set ONE of these in the env (no code change):
//   OPENAI_API_KEY      -> OpenAI       GROQ_API_KEY -> Groq       OPENROUTER_API_KEY -> OpenRouter
//   AI_API_KEY + AI_BASE_URL -> any other OpenAI-compatible provider
//   AI_MODEL (or OPENAI_MODEL) -> override the model for whichever of those is active
//
// ANTHROPIC IS THE SECOND PROVIDER (owner, 2026-10-18, the OpenAI account failed to recharge). The three
// sales AI paths — this file's aiChatJson, normalizer/ai-suggest.ts and weekly/ai-verify.ts — make their own
// raw calls rather than going through the shared createOpenAiResponseText, so they stayed dark while every
// other AI feature failed over. They now plan their providers HERE, with the same rules as the shared call
// (src/lib/ai/openai-client.ts): OpenAI-compatible first, Anthropic only when that account is dead
// (quota_exceeded or auth_failed), AI_PROVIDER=openai|anthropic pins one, and the shared "OpenAI is
// unavailable" memory (ten minutes, doubling to an hour while the account stays dead) is read and
// written so a failure seen by one caller spares the rest.
//
// With no key configured planSalesAi returns [] and callers degrade to a no-op (aiUsed=false).

import { callAnthropicMessages, AnthropicRequestError, hasAnthropicApiKey, resolveAnthropicModel } from "@/lib/ai/anthropic-fallback";
import { failoverLegTimeoutMs, isOpenAiUnavailable, noteOpenAiAvailable, noteOpenAiUnavailable, resolveAiProviderMode, shouldFailOverToNextProvider } from "@/lib/ai/openai-client";
import {
  aiErrorCodeForResponse,
  isQuotaExhaustedBody,
  recordAiCall,
  type AiCallComponent,
  type AiCallProvider,
  type AiCallRecord,
} from "@/lib/observability/ai-metrics";

type AiEnv = Record<string, string | undefined>;

export type AiProviderName = "generic" | "groq" | "openai" | "openrouter";
export type AiProvider = { baseUrl: string; key: string; model: string; name: AiProviderName };

export type AiModelDefaults = { openai: string; groq: string; openrouter: string; generic: string };

export const DEFAULT_AI_MODELS: AiModelDefaults = {
  openai: "gpt-4o-mini",
  groq: "llama-3.3-70b-versatile",
  openrouter: "openai/gpt-4o-mini",
  generic: "gpt-4o-mini",
};

export function resolveAiProvider(models: AiModelDefaults = DEFAULT_AI_MODELS, env: AiEnv = process.env): AiProvider | null {
  const baseOverride = env.AI_BASE_URL?.replace(/\/+$/, "");
  const modelOverride = env.AI_MODEL || env.OPENAI_MODEL;
  if (env.OPENAI_API_KEY) return { baseUrl: baseOverride || "https://api.openai.com/v1", key: env.OPENAI_API_KEY, model: modelOverride || models.openai, name: "openai" };
  if (env.GROQ_API_KEY) return { baseUrl: baseOverride || "https://api.groq.com/openai/v1", key: env.GROQ_API_KEY, model: modelOverride || models.groq, name: "groq" };
  if (env.OPENROUTER_API_KEY) return { baseUrl: baseOverride || "https://openrouter.ai/api/v1", key: env.OPENROUTER_API_KEY, model: modelOverride || models.openrouter, name: "openrouter" };
  if (env.AI_API_KEY && baseOverride) return { baseUrl: baseOverride, key: env.AI_API_KEY, model: modelOverride || models.generic, name: "generic" };
  return null;
}

// One provider the call may go to: an OpenAI-compatible chat endpoint, or Anthropic's Messages API.
export type SalesAiLeg = { kind: "anthropic"; model: string } | { kind: "chat"; provider: AiProvider };

/** The account a planned leg is billed to — the name a failed-over row gives its rescuer. */
export function salesAiLegProvider(leg: SalesAiLeg): AiCallProvider {
  return leg.kind === "anthropic" ? "anthropic" : leg.provider.name;
}

/**
 * What the failover loop tells each leg about what follows it. `failoverTo` is the next planned account, or
 * undefined on the last leg — the leg uses it to report a rescued failure as `failed_over` rather than as an
 * AI failure (see `legOutcome` and the account in ai-metrics.ts). `timeoutMs` is what this leg may spend:
 * the whole budget on the first leg, only what is left of it on a later one (undefined when the caller gave
 * no budget) — the same rule the shared call keeps (`failoverLegTimeoutMs`), so a failover never doubles
 * the wait the user sits through.
 */
export type SalesAiLegContext = { failoverTo?: AiCallProvider; timeoutMs?: number };

/** The outcome fields `recordAiCall` takes for a failed sales leg. A rescued one is never `error`. */
export function salesLegOutcome(
  code: SalesAiFailureCode,
  failoverTo: AiCallProvider | undefined,
): Pick<AiCallRecord, "failedOverTo" | "status"> {
  return failoverTo && shouldFailOverToNextProvider(code)
    ? { failedOverTo: failoverTo, status: "failed_over" }
    : { status: "error" };
}

/**
 * The providers to try, in order. `models` is the calling path's own default tier: Anthropic's model is
 * chosen from the OPENAI name in `models.openai` (a "mini" path gets the fast Claude model, ai-suggest's
 * gpt-4o gets the strong one) and NOT from AI_MODEL, which is an override for the OpenAI-compatible side only.
 * Only an environment with BOTH an OpenAI-compatible key and an Anthropic key ever gets a second entry.
 */
export function planSalesAi(
  models: AiModelDefaults = DEFAULT_AI_MODELS,
  env: AiEnv = process.env,
  nowMs = Date.now(),
): SalesAiLeg[] {
  const mode = resolveAiProviderMode(env);
  const provider = mode === "anthropic" ? null : resolveAiProvider(models, env);
  const chat: SalesAiLeg | null = provider ? { kind: "chat", provider } : null;
  const claude: SalesAiLeg | null =
    mode !== "openai" && hasAnthropicApiKey(env)
      ? { kind: "anthropic", model: resolveAnthropicModel(models.openai, env) }
      : null;
  if (chat && claude) {
    // The shared memory is about the OpenAI ACCOUNT, so it only reorders when the chat leg IS OpenAI.
    return provider?.name === "openai" && isOpenAiUnavailable(nowMs) ? [claude, chat] : [chat, claude];
  }
  if (chat) return [chat];
  if (claude) return [claude];
  return [];
}

export function hasAiProvider(models: AiModelDefaults = DEFAULT_AI_MODELS): boolean {
  return planSalesAi(models).length > 0;
}

/** The model that would answer FIRST right now — what cached answers are keyed by (see aiSuggestModel). */
export function firstSalesAiModel(models: AiModelDefaults = DEFAULT_AI_MODELS): string | null {
  const leg = planSalesAi(models)[0];
  if (!leg) return null;
  return leg.kind === "anthropic" ? leg.model : leg.provider.model;
}

export type SalesAiFailureCode = "auth_failed" | "failed" | "not_configured" | "quota_exceeded" | "rate_limited" | "timeout";

// The one error a leg throws, so the failover loop can read WHY it failed without parsing a message. The
// message is whatever the calling path shows its user; the code decides whether the next provider is tried.
export class SalesAiError extends Error {
  code: SalesAiFailureCode;
  status?: number;

  constructor(code: SalesAiFailureCode, message: string, status?: number) {
    super(message);
    this.name = "SalesAiError";
    this.code = code;
    this.status = status;
  }
}

/** What an OpenAI-compatible HTTP failure means for the app (402 is how OpenRouter says "out of credit"). */
export function salesAiFailureCodeFor(status: number, rawBody: string): SalesAiFailureCode {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 402) return "quota_exceeded";
  if (status === 429) return isQuotaExhaustedBody(rawBody) ? "quota_exceeded" : "rate_limited";
  return "failed";
}

/**
 * Runs `attempt` against each planned provider in turn. It moves to the next ONLY when the ACCOUNT is dead
 * (out of credit, key rejected) — a timeout, a rate limit or any other failure stays with the provider that
 * gave it and is thrown as it was. Throws not_configured when no provider is configured at all.
 *
 * `budgetMs` is the whole wait the caller allows across every leg: a later leg gets only what is left of it,
 * and when less than a second is left the earlier account's refusal is thrown instead of asking the next one.
 */
export async function runWithSalesAiFailover<T>(
  attempt: (leg: SalesAiLeg, context: SalesAiLegContext) => Promise<T>,
  models: AiModelDefaults = DEFAULT_AI_MODELS,
  budgetMs?: number,
): Promise<T> {
  const plan = planSalesAi(models);
  if (plan.length === 0) throw new SalesAiError("not_configured", "No AI provider is configured.");

  const startedAt = Date.now();
  let refusal: unknown;
  for (const [index, leg] of plan.entries()) {
    let timeoutMs = budgetMs;
    if (index > 0 && budgetMs !== undefined) {
      const leftMs = failoverLegTimeoutMs(budgetMs, Date.now() - startedAt);
      if (leftMs === null) throw refusal;
      timeoutMs = leftMs;
    }
    try {
      const next = plan[index + 1];
      const result = await attempt(leg, { failoverTo: next ? salesAiLegProvider(next) : undefined, timeoutMs });
      // OpenAI answered, so its account is alive: the shared wait starts from ten minutes again.
      if (leg.kind === "chat" && leg.provider.name === "openai") noteOpenAiAvailable();
      return result;
    } catch (error) {
      const code = error instanceof SalesAiError ? error.code : "failed";
      const failOver = shouldFailOverToNextProvider(code);
      if (failOver && leg.kind === "chat" && leg.provider.name === "openai" && hasAnthropicApiKey()) {
        noteOpenAiUnavailable();
      }
      if (!failOver || index === plan.length - 1) throw error;
      refusal = error;
    }
  }

  // Unreachable: `plan` is never empty and its last entry always throws above. Present for the compiler.
  throw new SalesAiError("failed", "No AI provider was attempted.");
}

/**
 * One Anthropic JSON round trip for a sales path: the same `system` + `user` pair the OpenAI-compatible leg
 * sends, the reply cleaned of any markdown fence. Records the call under the path's own component, so the
 * AI board and the out-of-credit alarm name the right feature. Throws SalesAiError; never logs the key.
 */
export async function anthropicJson(params: {
  component: AiCallComponent;
  /** The account asked after this one, when there is one — `SalesAiLegContext.failoverTo`. */
  failoverTo?: AiCallProvider;
  maxRetries?: number;
  maxTokens: number;
  model: string;
  purpose: string;
  system: string;
  timeoutMs: number;
  user: string;
}): Promise<{ model: string; text: string }> {
  const startedAt = Date.now();
  try {
    const reply = await callAnthropicMessages({
      format: { type: "json_object" },
      input: params.user,
      instructions: params.system,
      maxOutputTokens: params.maxTokens,
      maxRetries: params.maxRetries ?? 1,
      model: params.model,
      timeoutMs: params.timeoutMs,
      // The first Anthropic account refused for credit or its key and the second is being asked: its own
      // row, so the out-of-credit alarm still pages for the first although the call is answered.
      onAccountFailedOver: (refusal) =>
        recordAiCall({
          component: params.component,
          errorCode: refusal.code,
          failedOverTo: refusal.nextAccount,
          latencyMs: refusal.latencyMs,
          model: params.model,
          provider: refusal.account,
          purpose: params.purpose,
          status: "failed_over",
        }),
    });
    recordAiCall({
      component: params.component,
      inputTokens: reply.inputTokens,
      latencyMs: Date.now() - startedAt,
      model: reply.model,
      outputTokens: reply.outputTokens,
      provider: reply.account,
      purpose: params.purpose,
      status: "success",
    });
    return { model: reply.model, text: reply.outputText };
  } catch (error) {
    const failure = error instanceof AnthropicRequestError ? error : null;
    const code: SalesAiFailureCode = failure?.code ?? "failed";
    recordAiCall({
      component: params.component,
      errorCode: code,
      latencyMs: Date.now() - startedAt,
      model: params.model,
      // The account that gave the last refusal: the second, when the first was out of credit too.
      provider: failure?.account ?? "anthropic",
      purpose: params.purpose,
      ...salesLegOutcome(code, params.failoverTo),
    });
    throw new SalesAiError(code, failure ? failure.message : "The Anthropic request failed.", failure?.status);
  }
}

// One JSON chat round-trip. Throws a human-readable reason on HTTP failure (callers catch and degrade).
// Server-only — never logs the key; on error only the upstream status/body fragment. Falls over to
// Anthropic when the OpenAI-compatible account is dead (see the header).
export async function aiChatJson(
  system: string,
  user: string,
  opts?: { timeoutMs?: number; maxTokens?: number; purpose?: string },
): Promise<string> {
  const purpose = opts?.purpose ?? "sales_ai_chat";
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const maxTokens = opts?.maxTokens ?? 1500;

  return runWithSalesAiFailover(async (leg, { failoverTo, timeoutMs: legTimeoutMs = timeoutMs }) => {
    if (leg.kind === "anthropic") {
      const reply = await anthropicJson({ component: "sales_ai_provider", failoverTo, maxTokens, model: leg.model, purpose, system, timeoutMs: legTimeoutMs, user });
      return reply.text;
    }

    const { provider } = leg;
    const startedAt = Date.now();
    // Captured so the failure row can say WHY, not just that something failed. A row reading
    // "HTTP 401" is the difference between "the key is wrong" and "the model is busy" — the two
    // that looked identical during the 2026-09-02 outage.
    let upstreamStatus: number | undefined;
    let upstreamCode: string | undefined;
    try {
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        body: JSON.stringify({
          max_completion_tokens: maxTokens,
          messages: [
            { content: system, role: "system" },
            { content: user, role: "user" },
          ],
          model: provider.model,
          response_format: { type: "json_object" },
          temperature: 0,
        }),
        headers: { Authorization: `Bearer ${provider.key}`, "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(legTimeoutMs),
      });
      if (!res.ok) {
        upstreamStatus = res.status;
        const body = await res.text().catch(() => "");
        upstreamCode = aiErrorCodeForResponse(res.status, body);
        throw new SalesAiError(
          salesAiFailureCodeFor(res.status, body),
          `AI request failed (HTTP ${res.status}): ${body.slice(0, 200)}`,
          res.status,
        );
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      recordAiCall({
        component: "sales_ai_provider",
        inputTokens: json.usage?.prompt_tokens,
        latencyMs: Date.now() - startedAt,
        model: provider.model,
        outputTokens: json.usage?.completion_tokens,
        provider: provider.name,
        purpose,
        status: "success",
      });
      return json.choices?.[0]?.message?.content ?? "{}";
    } catch (error) {
      recordAiCall({
        component: "sales_ai_provider",
        errorCode: upstreamCode ?? (upstreamStatus === undefined ? "no_http_status" : String(upstreamStatus)),
        latencyMs: Date.now() - startedAt,
        model: provider.model,
        provider: provider.name,
        purpose,
        ...salesLegOutcome(error instanceof SalesAiError ? error.code : "failed", failoverTo),
      });
      throw error;
    }
  }, DEFAULT_AI_MODELS, timeoutMs);
}
