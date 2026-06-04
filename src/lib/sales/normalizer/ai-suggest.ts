// Optional AI assist for the bulk mapper: given the DISTINCT unknown item/territory NAMES and the
// Phoenix candidate list, ask Gemini (free tier) for the best match per unknown. SUGGEST-ONLY — the
// result just pre-fills the dropdowns; the user confirms before anything is saved. Privacy: only the
// item/place names + the candidate names are sent — never customer codes, addresses, or sales rows.
// Degrades gracefully: with no API key it is a no-op and the UI hides the button.

const MODEL = "gemini-2.0-flash";

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

// Returns best-guess {raw, code} pairs. Validates every returned code against the candidate set, so
// the AI can never invent a code. Batches to keep each request small + within the free tier.
export async function aiSuggest(kind: "product" | "territory", unknowns: AiUnknown[], candidates: AiCandidate[]): Promise<AiSuggestion[]> {
  const key = getGeminiKey();
  if (!key || unknowns.length === 0 || candidates.length === 0) return [];
  const validCodes = new Map(candidates.map((c) => [c.code.trim().toUpperCase(), c.code]));
  const out: AiSuggestion[] = [];
  const BATCH = 60;
  for (let i = 0; i < unknowns.length; i += BATCH) {
    const chunk = unknowns.slice(i, i + BATCH);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(kind, chunk, candidates) }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
      const arr = JSON.parse(text) as { code?: string | null; id?: number }[];
      for (const item of Array.isArray(arr) ? arr : []) {
        const idx = Number(item.id) - 1;
        const u = chunk[idx];
        const code = validCodes.get(String(item.code ?? "").trim().toUpperCase());
        if (u && code) out.push({ code, raw: u.raw });
      }
    } catch {
      // a failed/garbled batch is non-fatal — the user can still map by hand
    }
  }
  return out;
}
