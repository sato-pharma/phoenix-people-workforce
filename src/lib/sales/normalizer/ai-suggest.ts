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
// With no key it is a no-op and the UI hides the button.

import { resolveAiProvider, type AiProvider } from "@/lib/sales/ai/provider";

export type AiCandidate = { code: string; label: string };
export type AiUnknown = { raw: string; rawName?: string };
export type AiSuggestion = { code: string; raw: string };

// Provider resolution is shared (src/lib/sales/ai/provider.ts). ai-suggest keeps GPT-4o (the heavier
// model) for the harder name-matching task, overriding the shared "mini" defaults.
const AI_SUGGEST_MODELS = { openai: "gpt-4o", groq: "llama-3.3-70b-versatile", openrouter: "openai/gpt-4o", generic: "gpt-4o" } as const;

function resolveProvider(): AiProvider | null {
  return resolveAiProvider({ ...AI_SUGGEST_MODELS });
}

export function hasAiKey(): boolean {
  return resolveProvider() !== null;
}

function systemPrompt(kind: "product" | "territory"): string {
  return kind === "product"
    ? "You match a pharmaceutical distributor's raw product names (English or Arabic) to an official product catalog. Match ONLY when you are confident it is the SAME medicine (same active product); otherwise use null. Ignore pack size / tablet count differences. Reply with JSON only."
    : "You match a distributor's raw territory / district names (English or Arabic) to an official territory (brick) list. Match ONLY when confident the place is the same; otherwise use null. Reply with JSON only.";
}

function userPrompt(unknowns: AiUnknown[], candidates: AiCandidate[]): string {
  const cands = candidates.map((c) => `${c.code} | ${c.label}`).join("\n");
  const items = unknowns.map((u, i) => `${i + 1} | ${u.rawName || u.raw}`).join("\n");
  return `Official list (code | name):
${cands}

Items to match (id | text):
${items}

Return ONLY JSON of this exact shape: {"matches":[{"id":<id>,"code":"<official code from the list above, or null>"}]}. Use a code only if it appears verbatim in the official list.`;
}

function shortReason(raw: string): string {
  try { const j = JSON.parse(raw) as { error?: { message?: string } }; return String(j?.error?.message ?? raw).split("\n")[0].slice(0, 200); }
  catch { return raw.slice(0, 200); }
}

// One chat-completions call. Returns the model's JSON text, or throws a human-readable reason on failure
// so the UI surfaces it instead of a misleading "no matches".
async function generate(provider: AiProvider, kind: "product" | "territory", unknowns: AiUnknown[], candidates: AiCandidate[]): Promise<string> {
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    body: JSON.stringify({
      messages: [
        { content: systemPrompt(kind), role: "system" },
        { content: userPrompt(unknowns, candidates), role: "user" },
      ],
      model: provider.model,
      response_format: { type: "json_object" },
      temperature: 0,
    }),
    headers: { Authorization: `Bearer ${provider.key}`, "Content-Type": "application/json" },
    method: "POST",
  });
  if (res.ok) {
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "{}";
  }
  const body = await res.text().catch(() => "");
  if (res.status === 429) throw new Error("AI is rate-limited right now — wait a moment and click AI suggest again.");
  if (res.status === 401) throw new Error("AI key was rejected (401) — check the API key is valid and has credit/access.");
  throw new Error(`AI request failed (HTTP ${res.status}): ${shortReason(body)}`);
}

// Returns best-guess {raw, code} pairs. Validates every returned code against the candidate set, so the
// AI can never invent a code. Batches to keep each request small. If every batch fails (e.g. bad key or
// rate limit), throws the reason so the UI shows it instead of a misleading "no matches".
export async function aiSuggest(kind: "product" | "territory", unknowns: AiUnknown[], candidates: AiCandidate[]): Promise<AiSuggestion[]> {
  const provider = resolveProvider();
  if (!provider || unknowns.length === 0 || candidates.length === 0) return [];
  const validCodes = new Map(candidates.map((c) => [c.code.trim().toUpperCase(), c.code]));
  const out: AiSuggestion[] = [];
  const BATCH = 60;
  let lastError = "";
  for (let i = 0; i < unknowns.length; i += BATCH) {
    const chunk = unknowns.slice(i, i + BATCH);
    try {
      const text = await generate(provider, kind, chunk, candidates);
      const parsed = JSON.parse(text) as { matches?: { code?: string | null; id?: number }[] } | { code?: string | null; id?: number }[];
      const arr = Array.isArray(parsed) ? parsed : parsed.matches ?? [];
      for (const item of Array.isArray(arr) ? arr : []) {
        const idx = Number(item.id) - 1;
        const u = chunk[idx];
        const code = validCodes.get(String(item.code ?? "").trim().toUpperCase());
        if (u && code) out.push({ code, raw: u.raw });
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : "AI error.";
    }
  }
  if (out.length === 0 && lastError) throw new Error(lastError);
  return out;
}
