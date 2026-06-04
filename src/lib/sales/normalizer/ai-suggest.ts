// Optional AI assist for the bulk mapper: given the DISTINCT unknown item/territory NAMES and the
// Phoenix candidate list, ask Gemini (free tier) for the best match per unknown. SUGGEST-ONLY — the
// result just pre-fills the dropdowns; the user confirms before anything is saved. Privacy: only the
// item/place names + the candidate names are sent — never customer codes, addresses, or sales rows.
// Degrades gracefully: with no API key it is a no-op and the UI hides the button.

// 2.5-flash + 2.5-flash-lite are on the free tier (2.0-flash returns limit:0 for new keys). Try flash
// first for the best matches; fall back to flash-lite (its own separate quota) if flash is busy.
const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"] as const;

export function getGeminiKey(): string {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "";
}

export function hasGeminiKey(): boolean {
  return Boolean(getGeminiKey());
}

export type AiCandidate = { code: string; label: string };
export type AiUnknown = { raw: string; rawName?: string };
export type AiSuggestion = { code: string; raw: string };

function buildPrompt(kind: "product" | "territory", unknowns: AiUnknown[], candidates: AiCandidate[]): string {
  const intro = kind === "product"
    ? "You match a pharmaceutical distributor's raw product names (English or Arabic) to an official product catalog. Match ONLY when you are confident it is the SAME medicine (same active product); otherwise use null. Ignore pack size / tablet count differences."
    : "You match a distributor's raw territory / district names (English or Arabic) to an official territory (brick) list. Match ONLY when confident the place is the same; otherwise use null.";
  const cands = candidates.map((c) => `${c.code} | ${c.label}`).join("\n");
  const items = unknowns.map((u, i) => `${i + 1} | ${u.rawName || u.raw}`).join("\n");
  return `${intro}

Official list (code | name):
${cands}

Items to match (id | text):
${items}

Return ONLY a JSON array, one object per item: [{"id": <id>, "code": "<official code, or null>"}]. Use a code only if it appears in the official list above.`;
}

function shortReason(raw: string): string {
  try { const j = JSON.parse(raw) as { error?: { message?: string } }; return String(j?.error?.message ?? raw).split("\n")[0].slice(0, 180); }
  catch { return raw.slice(0, 180); }
}

// One generateContent call with model fallback (flash -> flash-lite, each its own free-tier quota).
// Returns the model's JSON text, or throws a human-readable reason if every model fails (e.g. quota).
async function generate(prompt: string, key: string): Promise<string> {
  let lastErr = "AI request failed.";
  for (const model of MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0 } }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (res.ok) {
        const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
      }
      lastErr = res.status === 429
        ? "AI is temporarily rate-limited on the free tier - wait about a minute and click AI suggest again."
        : `AI request failed (HTTP ${res.status}): ${shortReason(await res.text().catch(() => ""))}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "AI network error.";
    }
  }
  throw new Error(lastErr);
}

// Returns best-guess {raw, code} pairs. Validates every returned code against the candidate set, so the
// AI can never invent a code. Batches to keep each request small + within the free tier. If every batch
// fails (e.g. quota), throws the reason so the UI shows it instead of a misleading "no matches".
export async function aiSuggest(kind: "product" | "territory", unknowns: AiUnknown[], candidates: AiCandidate[]): Promise<AiSuggestion[]> {
  const key = getGeminiKey();
  if (!key || unknowns.length === 0 || candidates.length === 0) return [];
  const validCodes = new Map(candidates.map((c) => [c.code.trim().toUpperCase(), c.code]));
  const out: AiSuggestion[] = [];
  const BATCH = 60;
  let lastError = "";
  for (let i = 0; i < unknowns.length; i += BATCH) {
    const chunk = unknowns.slice(i, i + BATCH);
    try {
      const arr = JSON.parse(await generate(buildPrompt(kind, chunk, candidates), key)) as { code?: string | null; id?: number }[];
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
