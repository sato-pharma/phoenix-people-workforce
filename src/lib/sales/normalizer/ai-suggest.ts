// Optional AI assist for the bulk mapper: given the DISTINCT unknown item/territory NAMES and the
// Phoenix candidate list, ask a chat model for the best match per unknown. SUGGEST-ONLY — the result
// just pre-fills the dropdowns; the user confirms before anything is saved. Privacy: only the
// item/place names + the candidate names are sent — never customer codes, addresses, or sales rows.
//
// Provider-agnostic via the OpenAI-compatible /chat/completions API. Defaults to OpenAI GPT-4o; set
// any of these in the env (no code change) to swap engines:
//   OPENAI_API_KEY      -> OpenAI         (default model gpt-4o)
//   GROQ_API_KEY        -> Groq           (default model llama-3.3-70b-versatile)
//   OPENROUTER_API_KEY  -> OpenRouter     (default model openai/gpt-4o)
//   AI_API_KEY + AI_BASE_URL              -> any other OpenAI-compatible provider
//   AI_MODEL            -> override the model for whichever provider is active
// ANTHROPIC_API_KEY is the second provider: when the account above is out of credit or its key is
// rejected, the batch is asked of Claude instead (src/lib/sales/ai/provider.ts holds the plan).
// With no key it is a no-op and the UI hides the button.

import {
  anthropicJson,
  firstSalesAiModel,
  hasAiProvider,
  runWithSalesAiFailover,
  salesAiFailureCodeFor,
  SalesAiError,
  type AiProvider,
} from "@/lib/sales/ai/provider";
import { aiErrorCodeForResponse, isQuotaExhaustedBody, recordAiCall } from "@/lib/observability/ai-metrics";

export type AiCandidate = { code: string; label: string };
// rawAddress + rawTerritory carry the extra geo signal used for CUSTOMER (pharmacy) matching:
// the customer's postal address and the distributor's own governorate/area text.
export type AiUnknown = { raw: string; rawName?: string; rawAddress?: string; rawTerritory?: string };
export type AiSuggestion = { code: string; raw: string; confidence?: number };
export type AiKind = "product" | "territory" | "customer";

// Provider resolution is shared (src/lib/sales/ai/provider.ts). ai-suggest keeps GPT-4o (the heavier
// model) for the harder name-matching task, overriding the shared "mini" defaults.
const AI_SUGGEST_MODELS = { openai: "gpt-4o", groq: "llama-3.3-70b-versatile", openrouter: "openai/gpt-4o", generic: "gpt-4o" } as const;
// The same defaults as a mutable copy, for the planner (it also picks Claude's strong tier from "gpt-4o").
const SUGGEST_MODELS = { ...AI_SUGGEST_MODELS };

export function hasAiKey(): boolean {
  return hasAiProvider(SUGGEST_MODELS);
}

// The model that answers FIRST right now. customer-ai-answers.ts keeps each model's answers apart, so a
// model change asks again instead of serving another model's answers. Once OpenAI has been seen out of
// credit this is Claude's model, which is why customer-suggest.ts asks again after the call.
export function aiSuggestModel(): string | null {
  return firstSalesAiModel(SUGGEST_MODELS);
}

function systemPrompt(kind: AiKind): string {
  if (kind === "product") {
    return "You match a pharmaceutical distributor's raw product names (English or Arabic) to an official product catalog. Match ONLY when you are confident it is the SAME medicine (same active product); otherwise use null. Ignore pack size / tablet count differences. Reply with JSON only.";
  }
  if (kind === "customer") {
    return `You are an expert in Egyptian geography and pharmaceutical sales territories. Your task is to geo-locate each pharmacy to the correct Phoenix brick territory.

Each item gives: pharmacy NAME, postal ADDRESS, and the distributor's GOVERNORATE/AREA text (English or Arabic — may be blank).

CRITICAL: When the governorate/area text is blank, you MUST still attempt to resolve the location by carefully parsing the NAME and ADDRESS fields. Arabic addresses routinely embed: village name (قرية / ناحية), city name, district center (مركز), and governorate (محافظة) as part of the pharmacy name or street address. Extract every geographic signal you can find.

The official brick list is shown as: brick_id — brick_name — area, region.

For each item:
1. Extract all geographic signals from name, address, and territory fields
2. Match to the brick whose area/region best fits the identified location
3. Assign a confidence score (integer 0–100):
   - 90–100: Geography is unambiguous (governorate or city clearly identified)
   - 70–89: Strong match, minor ambiguity
   - 40–69: Reasonable inference, some uncertainty
   - 1–39: Weak signal — manual verification recommended
4. Use null for code when no geographic match is possible (omit confidence when code is null)

Reply with JSON only.`;
  }
  return "You match a distributor's raw territory / district names (English or Arabic) to an official territory (brick) list shown as 'brick — area, region'. Match ONLY when confident the place is the same; otherwise use null. Reply with JSON only.";
}

export type AiReferenceAlias = { raw: string; code: string };

// How many historical alias lines we paste into EACH batch prompt. Was 800 — but for CUSTOMER matching
// those are long (often Arabic) name+address strings, so 800 pushed a single request past ~45k tokens,
// over OpenAI's per-minute token budget on lower gpt-4o tiers. That surfaced to users as a permanent
// "AI is rate-limited" error that waiting never cleared. 120 keeps the strongest historical signal while
// dropping each request to ~15-20k tokens. Raise via AI_SUGGEST_MAX_REFERENCE_ALIASES only on a higher tier.
const MAX_REFERENCE_ALIASES = Math.max(1, Number(process.env.AI_SUGGEST_MAX_REFERENCE_ALIASES) || 120);

// Build one item line. For customers we fold name + address + governorate into the text so the AI
// has the full geographic signal; product/territory just use the single raw name.
function itemText(u: AiUnknown, kind: AiKind): string {
  if (kind === "customer") {
    return [u.rawName || u.raw, u.rawAddress, u.rawTerritory].map((s) => String(s ?? "").trim()).filter(Boolean).join(" | ");
  }
  return u.rawName || u.raw;
}

function userPrompt(unknowns: AiUnknown[], candidates: AiCandidate[], kind: AiKind, referenceAliases?: AiReferenceAlias[]): string {
  const cands = candidates.map((c) => `${c.code} | ${c.label}`).join("\n");
  const items = unknowns.map((u, i) => `${i + 1} | ${itemText(u, kind)}`).join("\n");
  const refLabel = kind === "customer"
    ? "Historical customer → brick placements already learned (customer name/address → brick code). Use these as strong reference for similar pharmacies/addresses:"
    : "Historical mappings already learned (raw text → official code). Use these as strong reference — if you see the same or very similar text, reuse the same code:";
  const refSection = referenceAliases && referenceAliases.length > 0
    ? `\n${refLabel}\n${referenceAliases.slice(0, MAX_REFERENCE_ALIASES).map((a) => `${a.raw} → ${a.code}`).join("\n")}\n`
    : "";
  return `Official list (code | name):
${cands}
${refSection}
Items to match (id | text):
${items}

Return ONLY JSON of this exact shape: ${kind === "customer"
    ? `{"matches":[{"id":<id>,"code":"<official code from the list above, or null>","confidence":<integer 0-100, omit when code is null>}]}`
    : `{"matches":[{"id":<id>,"code":"<official code from the list above, or null>"}]}`}. Use a code only if it appears verbatim in the official list.`;
}

function shortReason(raw: string): string {
  try { const j = JSON.parse(raw) as { error?: { message?: string } }; return String(j?.error?.message ?? raw).split("\n")[0].slice(0, 200); }
  catch { return raw.slice(0, 200); }
}

// OpenAI (and compatible providers) return HTTP 429 for TWO very different problems: a transient
// per-minute rate limit (waiting/retrying helps) OR a permanently exhausted quota — out of credit /
// billing not set up (waiting never helps). Detect the quota case from the error body so the UI can
// tell the user to fix billing instead of endlessly "waiting a moment". The detector lives in
// ai-metrics.ts so every AI path reports the out-of-credit case the same way (and pages the owner).
const isQuotaExhausted = isQuotaExhaustedBody;

// Transient per-minute rate limits (not the quota-exhausted case, which retrying never fixes)
// clear on their own within a few seconds — retry automatically instead of forcing the user to
// notice the failure and manually re-click "AI suggest" for every affected batch.
const MAX_RATE_LIMIT_RETRIES = 3;
// Base backoff delay (doubles each attempt: 1x, 2x, 4x). Read fresh on every call (not a
// module-level constant) so it's overridable at runtime — the retry test suite sets this env var
// before calling aiSuggest, so it doesn't have to burn real wall-clock time (1s+2s+4s = 7s)
// waiting out production-realistic delays. A module-level constant would capture whatever the env
// var was at import time, before any test had a chance to set it.
function rateLimitRetryBaseMs(): number {
  return Math.max(0, Number(process.env.AI_SUGGEST_RETRY_BASE_MS) || 1000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// What the UI shows for each way an AI account can fail. Both providers' failures map onto these, so the
// message names the fix (billing, key, waiting) whichever account answered last.
const OUT_OF_CREDIT_MESSAGE = "AI account is out of credit / quota — this is a billing problem, not a busy server, so waiting will NOT help. Top up or fix billing on the AI provider account, then try again.";
const KEY_REJECTED_MESSAGE = "AI key was rejected (401) — check the API key is valid and has credit/access.";
const RATE_LIMITED_MESSAGE = "AI is rate-limited right now — wait a moment (or lower the batch size / run fewer rows at once), then click AI suggest again.";
// Claude has no JSON mode here, so a blank, prose-only or truncated reply is possible; the operator should read this, not a parser error.
const UNREADABLE_MESSAGE = "AI returned an answer that could not be read — click AI suggest again.";

// One batch asked of the planned provider(s). Returns the model's JSON text, or throws a human-readable
// reason on failure so the UI surfaces it instead of a misleading "no matches". OpenAI-compatible first;
// Claude only when that account is out of credit or its key is rejected (runWithSalesAiFailover).
async function generate(kind: AiKind, unknowns: AiUnknown[], candidates: AiCandidate[], referenceAliases?: AiReferenceAlias[]): Promise<string> {
  const system = systemPrompt(kind);
  const user = userPrompt(unknowns, candidates, kind, referenceAliases);
  return runWithSalesAiFailover(
    (leg) => (leg.kind === "anthropic" ? askClaude(leg.model, kind, system, user) : askChatProvider(leg.provider, kind, system, user)),
    SUGGEST_MODELS,
  );
}

// One batch of up to 60 rows: ~1.5k tokens of answer, so 4k is headroom, and a generous timeout because
// the chat leg has none of its own.
async function askClaude(model: string, kind: AiKind, system: string, user: string): Promise<string> {
  try {
    const reply = await anthropicJson({
      component: "sales_normalizer_ai_suggest",
      maxRetries: MAX_RATE_LIMIT_RETRIES,
      maxTokens: 4_000,
      model,
      purpose: `ai_suggest_${kind}`,
      system,
      timeoutMs: 120_000,
      user,
    });
    return reply.text;
  } catch (error) {
    if (!(error instanceof SalesAiError)) throw error;
    if (error.code === "quota_exceeded") throw new SalesAiError(error.code, OUT_OF_CREDIT_MESSAGE, error.status);
    if (error.code === "auth_failed") throw new SalesAiError(error.code, KEY_REJECTED_MESSAGE, error.status);
    if (error.code === "rate_limited") throw new SalesAiError(error.code, RATE_LIMITED_MESSAGE, error.status);
    throw error;
  }
}

// One chat-completions call against the OpenAI-compatible provider.
async function askChatProvider(provider: AiProvider, kind: AiKind, system: string, user: string): Promise<string> {
  const body_ = JSON.stringify({
    messages: [
      { content: system, role: "system" },
      { content: user, role: "user" },
    ],
    model: provider.model,
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const startedAt = Date.now();
  // Captured so the failure row can say WHY. This is the exact path that answered 401 for days on
  // 2026-09-02 while nothing anywhere recorded that it had.
  let upstreamStatus: number | undefined;
  let upstreamCode: string | undefined;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        body: body_,
        headers: { Authorization: `Bearer ${provider.key}`, "Content-Type": "application/json" },
        method: "POST",
      });
      if (res.ok) {
        const json = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        recordAiCall({
          component: "sales_normalizer_ai_suggest",
          inputTokens: json.usage?.prompt_tokens,
          latencyMs: Date.now() - startedAt,
          model: provider.model,
          outputTokens: json.usage?.completion_tokens,
          provider: provider.name,
          purpose: `ai_suggest_${kind}`,
          status: "success",
        });
        return json.choices?.[0]?.message?.content ?? "{}";
      }
      upstreamStatus = res.status;
      const respBody = await res.text().catch(() => "");
      upstreamCode = aiErrorCodeForResponse(res.status, respBody);
      if (res.status === 429 && !isQuotaExhausted(respBody)) {
        if (attempt < MAX_RATE_LIMIT_RETRIES) {
          // Exponential backoff with jitter: base, 2x base, 4x base (+ up to 250ms jitter).
          await delay(2 ** attempt * rateLimitRetryBaseMs() + Math.floor(Math.random() * 250));
          continue;
        }
        throw new SalesAiError("rate_limited", RATE_LIMITED_MESSAGE, res.status);
      }
      if (res.status === 429) throw new SalesAiError("quota_exceeded", OUT_OF_CREDIT_MESSAGE, res.status);
      if (res.status === 401) throw new SalesAiError("auth_failed", KEY_REJECTED_MESSAGE, res.status);
      throw new SalesAiError(salesAiFailureCodeFor(res.status, respBody), `AI request failed (HTTP ${res.status}): ${shortReason(respBody)}`, res.status);
    }
  } catch (error) {
    recordAiCall({
      component: "sales_normalizer_ai_suggest",
      errorCode: upstreamCode ?? (upstreamStatus === undefined ? "no_http_status" : String(upstreamStatus)),
      latencyMs: Date.now() - startedAt,
      model: provider.model,
      provider: provider.name,
      purpose: `ai_suggest_${kind}`,
      status: "error",
    });
    throw error;
  }
}

// Returns best-guess {raw, code} pairs. Validates every returned code against the candidate set, so the
// AI can never invent a code. Batches to keep each request small. If every batch fails (e.g. bad key or
// rate limit), throws the reason so the UI shows it instead of a misleading "no matches".
export async function aiSuggest(kind: AiKind, unknowns: AiUnknown[], candidates: AiCandidate[], referenceAliases?: AiReferenceAlias[]): Promise<AiSuggestion[]> {
  if (!hasAiKey() || unknowns.length === 0 || candidates.length === 0) return [];
  const validCodes = new Map(candidates.map((c) => [c.code.trim().toUpperCase(), c.code]));
  const out: AiSuggestion[] = [];
  const BATCH = 60;
  let lastError = "";
  for (let i = 0; i < unknowns.length; i += BATCH) {
    const chunk = unknowns.slice(i, i + BATCH);
    try {
      const text = await generate(kind, chunk, candidates, referenceAliases);
      const parsed = JSON.parse(text) as { matches?: { code?: string | null; id?: number; confidence?: number | null }[] } | { code?: string | null; id?: number; confidence?: number | null }[];
      if (parsed === null || typeof parsed !== "object") throw new SyntaxError("The AI reply was not a JSON object.");
      const arr = Array.isArray(parsed) ? parsed : parsed.matches ?? [];
      for (const item of Array.isArray(arr) ? arr : []) {
        const idx = Number(item.id) - 1;
        const u = chunk[idx];
        const code = validCodes.get(String(item.code ?? "").trim().toUpperCase());
        const confidence = typeof item.confidence === "number"
          ? Math.max(0, Math.min(100, Math.round(item.confidence)))
          : undefined;
        if (u && code) out.push({ code, raw: u.raw, confidence });
      }
    } catch (e) {
      lastError = e instanceof SyntaxError ? UNREADABLE_MESSAGE : e instanceof Error ? e.message : "AI error.";
    }
  }
  if (out.length === 0 && lastError) throw new Error(lastError);
  return out;
}
