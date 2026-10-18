// AI helper, ONLY when the deterministic recognizer is stuck. When a raw upload fails header
// validation, this asks an LLM to explain — in plain English — which expected column is missing or
// renamed, and to suggest which of the file's actual headers maps to it. SUGGEST/EXPLAIN ONLY: the
// deterministic header gate (validateSheetHeaders) stays the sole authority; this never changes the
// verdict. With no AI key it is a no-op (aiUsed=false), so an upload is never frozen by AI.
//
// PRIVACY: only COLUMN TITLES leave the server — the file's header-row text + the profile's expected
// column labels. Never data rows, quantities, customer codes, addresses, or product names (mirrors the
// posture of ai-suggest.ts / weekly ai-verify.ts).

import { logError } from "@/lib/observability/log";
import { aiChatJson, hasAiProvider } from "@/lib/sales/ai/provider";

export type HeaderMismatchSuggestion = { expected: string; suggestedHeader: string | null; note?: string };
export type HeaderMismatchExplanation = { aiUsed: boolean; summary: string; suggestions: HeaderMismatchSuggestion[] };

export type HeaderMismatchInput = {
  distributorName: string;
  observedHeaders: string[]; // the uploaded file's column titles (header row ONLY — never data rows)
  missingGroups: { label: string; expected: string[] }[]; // required fields that failed + accepted header aliases
};

const EMPTY: HeaderMismatchExplanation = { aiUsed: false, summary: "", suggestions: [] };

// PURE payload builder (exported for the privacy test): the request carries ONLY the file's column
// titles and the expected column labels — there is no path for a data row to enter it.
export function buildHeaderMismatchMessages(input: HeaderMismatchInput): { system: string; user: string } {
  const system =
    "You help an operator fix a pharmaceutical distributor's Excel export that failed column validation. " +
    "You are given ONLY the column TITLES found in the file and, per required field, the column titles the " +
    "importer expects (English or Arabic). Explain briefly which expected column is missing or appears renamed, " +
    "and for each, suggest which of the FOUND titles most likely maps to it (or null if none fits). Never invent a " +
    "header that is not in the found list. Reply with JSON only.";
  const found = input.observedHeaders.map((h) => `"${h}"`).join(", ") || "(none)";
  const expected = input.missingGroups
    .map((g) => `- ${g.label}: expects one of [${g.expected.map((e) => `"${e}"`).join(", ")}]`)
    .join("\n");
  const user =
    `Distributor: ${input.distributorName}\n\n` +
    `Column titles FOUND in the file:\n${found}\n\n` +
    `Required fields that did NOT match (field: accepted titles):\n${expected}\n\n` +
    `Return ONLY JSON of this exact shape: ` +
    `{"summary":"<one or two plain sentences naming what is wrong>","suggestions":[{"expected":"<field label>","suggestedHeader":"<one of the FOUND titles, or null>","note":"<short reason>"}]}.`;
  return { system, user };
}

export async function explainHeaderMismatch(input: HeaderMismatchInput): Promise<HeaderMismatchExplanation> {
  if (!hasAiProvider() || input.observedHeaders.length === 0 || input.missingGroups.length === 0) return EMPTY;
  // Only a FOUND title (or null) may be suggested — the AI can never invent a header.
  const foundSet = new Set(input.observedHeaders.map((h) => h.trim().toLowerCase()));
  try {
    const { system, user } = buildHeaderMismatchMessages(input);
    const text = await aiChatJson(system, user);
    const parsed = JSON.parse(text) as { summary?: unknown; suggestions?: { expected?: unknown; suggestedHeader?: unknown; note?: unknown }[] };
    const suggestions: HeaderMismatchSuggestion[] = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((s) => {
          const suggested = s.suggestedHeader == null ? null : String(s.suggestedHeader);
          const valid = suggested && foundSet.has(suggested.trim().toLowerCase()) ? suggested : null;
          return { expected: String(s.expected ?? "").slice(0, 120), suggestedHeader: valid, note: s.note ? String(s.note).slice(0, 200) : undefined };
        }).filter((s) => s.expected)
      : [];
    return { aiUsed: true, summary: String(parsed.summary ?? "").slice(0, 600), suggestions };
  } catch (error) {
    logError("Header mismatch AI explain failed", {
      labels: { event: "sos_ai_explain_failed" },
      error,
    });
    return EMPTY;
  }
}
