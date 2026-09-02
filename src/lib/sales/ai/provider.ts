// Shared OpenAI-compatible AI provider resolution + a single JSON chat helper for the Sales module.
// Provider-agnostic via the /chat/completions API. Set ONE of these in the env (no code change):
//   OPENAI_API_KEY      -> OpenAI       GROQ_API_KEY -> Groq       OPENROUTER_API_KEY -> OpenRouter
//   AI_API_KEY + AI_BASE_URL -> any other OpenAI-compatible provider
//   AI_MODEL (or OPENAI_MODEL) -> override the model for whichever provider is active
// With no key configured resolveAiProvider returns null and callers degrade to a no-op (aiUsed=false).
//
// NOTE: the older src/lib/sales/normalizer/ai-suggest.ts and src/lib/sales/weekly/ai-verify.ts still
// carry their own copies of this resolver; consolidating them onto this module is a safe follow-up
// (kept separate here to avoid touching those live paths in the AI-explain change).

import { recordAiCall } from "@/lib/observability/ai-metrics";

export type AiProvider = { baseUrl: string; key: string; model: string };

export type AiModelDefaults = { openai: string; groq: string; openrouter: string; generic: string };

const DEFAULT_MODELS: AiModelDefaults = {
  openai: "gpt-4o-mini",
  groq: "llama-3.3-70b-versatile",
  openrouter: "openai/gpt-4o-mini",
  generic: "gpt-4o-mini",
};

export function resolveAiProvider(models: AiModelDefaults = DEFAULT_MODELS): AiProvider | null {
  const baseOverride = process.env.AI_BASE_URL?.replace(/\/+$/, "");
  const modelOverride = process.env.AI_MODEL || process.env.OPENAI_MODEL;
  if (process.env.OPENAI_API_KEY) return { baseUrl: baseOverride || "https://api.openai.com/v1", key: process.env.OPENAI_API_KEY, model: modelOverride || models.openai };
  if (process.env.GROQ_API_KEY) return { baseUrl: baseOverride || "https://api.groq.com/openai/v1", key: process.env.GROQ_API_KEY, model: modelOverride || models.groq };
  if (process.env.OPENROUTER_API_KEY) return { baseUrl: baseOverride || "https://openrouter.ai/api/v1", key: process.env.OPENROUTER_API_KEY, model: modelOverride || models.openrouter };
  if (process.env.AI_API_KEY && baseOverride) return { baseUrl: baseOverride, key: process.env.AI_API_KEY, model: modelOverride || models.generic };
  return null;
}

export function hasAiProvider(): boolean {
  return resolveAiProvider() !== null;
}

// One JSON chat-completions round-trip. Throws a human-readable reason on HTTP failure (callers catch
// and degrade). Server-only — never logs the key; on error only the upstream status/body fragment.
export async function aiChatJson(
  provider: AiProvider,
  system: string,
  user: string,
  opts?: { timeoutMs?: number; maxTokens?: number; purpose?: string },
): Promise<string> {
  const purpose = opts?.purpose ?? "sales_ai_chat";
  const startedAt = Date.now();
  // Captured so the failure row can say WHY, not just that something failed. A row reading
  // "HTTP 401" is the difference between "the key is wrong" and "the model is busy" — the two
  // that looked identical during the 2026-09-02 outage.
  let upstreamStatus: number | undefined;
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      body: JSON.stringify({
        max_completion_tokens: opts?.maxTokens ?? 1500,
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
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 45_000),
    });
    if (!res.ok) {
      upstreamStatus = res.status;
      const body = await res.text().catch(() => "");
      throw new Error(`AI request failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
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
      purpose,
      status: "success",
    });
    return json.choices?.[0]?.message?.content ?? "{}";
  } catch (error) {
    recordAiCall({
      component: "sales_ai_provider",
      errorCode: upstreamStatus === undefined ? "no_http_status" : String(upstreamStatus),
      latencyMs: Date.now() - startedAt,
      model: provider.model,
      purpose,
      status: "error",
    });
    throw error;
  }
}
