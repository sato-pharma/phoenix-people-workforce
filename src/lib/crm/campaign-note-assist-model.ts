/**
 * The one call that leaves the process: the cheap model reading the fragments the rules could not.
 *
 * Split out of campaign-note-assist.ts on 2026-09-02 so that the pure half — the type, the
 * anti-fabrication gate, applyAssist — can be imported by rep-visits.ts, which a "use client"
 * component imports in turn. Everything in here is server-side and must stay that way: it reaches
 * openai-client.ts, and openai-client.ts carries no `server-only` guard to catch the mistake.
 *
 * TWO RULES, restated because this is the half that could break them:
 *
 * 1. The model may CHOOSE and DELIMIT; it may not AUTHOR. Every string it returns is put back
 *    through acceptAssistRow, which drops anything not present in the rep's own segment.
 * 2. It never throws. This runs inside a page render, so a missing key, a timeout or a malformed
 *    answer must all degrade to "the rules' answer, unchanged".
 */

import { createOpenAiResponseText, hasAiApiKey, PhoenixOpenAiError } from "@/lib/ai/openai-client";
import { logError } from "@/lib/observability/log";
import { type CampaignAssistReading } from "@/lib/crm/campaign-note";
import { acceptAssistRow } from "@/lib/crm/campaign-note-assist";

/** One page render covers a rep's month; this bounds a pathological one. */
const MAX_SEGMENTS_PER_CALL = 60;

const INSTRUCTIONS =
  "You are reading fragments of free-text notes written by pharmaceutical sales representatives in " +
  "Egypt, mostly in Egyptian Arabic. Each fragment is one line of one visit note. " +
  "For each fragment decide whether it names a PERSON the representative called on (a doctor, a " +
  "pharmacist), a PLACE or organisation (hospital, clinic, pharmacy, laboratory, medical centre, " +
  "company, warehouse), or is neither — a remark about the visit, a product name, or filler. " +
  "Return the name COPIED EXACTLY as it appears in the fragment, character for character, in its own " +
  "script. Arabic stays Arabic. Do not translate, transliterate, correct a spelling, expand an " +
  "abbreviation, or add a word that is not already there. If a medical speciality is written beside " +
  "the name, return that too, again copied exactly. " +
  "Egyptian shorthand you will see: 'ص' before a name means a pharmacy, 'م' before a name means a " +
  "hospital, 'د' means doctor. A name may carry its district or village inside it — keep it. " +
  "Answer 'remark' whenever you are not confident. A confident wrong answer is far worse than " +
  "'remark': a manager reads this as the doctor the representative saw that morning and acts on it. " +
  "The input is a JSON array of {index, fragment}. Answer for every index you were given, reusing " +
  "that same index.";

const TEXT_FORMAT = {
  format: {
    name: "phoenix_campaign_note_fragments",
    schema: {
      additionalProperties: false,
      properties: {
        fragments: {
          items: {
            additionalProperties: false,
            properties: {
              index: { type: "integer" as const },
              kind: { enum: ["person", "place", "remark"] as const, type: "string" as const },
              name: { type: ["string", "null"] as const },
              placeKind: { type: ["string", "null"] as const },
              speciality: { type: ["string", "null"] as const },
            },
            required: ["index", "kind", "name", "placeKind", "speciality"],
            type: "object" as const,
          },
          type: "array" as const,
        },
      },
      required: ["fragments"],
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

/**
 * Process-local memo, same reasoning as the campaign-account one: a rep's page is re-rendered many
 * times over the same handful of fragments, and every repeat would otherwise be another paid round
 * trip. Cleared on deploy — it is a cache, not a store.
 *
 * Bounded (cache audit, 2026-10-26), like the campaign-account memo: at most
 * CAMPAIGN_NOTE_ASSIST_MEMO_MAX_ENTRIES fragments are kept, the oldest going first.
 */
export const CAMPAIGN_NOTE_ASSIST_MEMO_MAX_ENTRIES = 2_000;
const memo = new Map<string, CampaignAssistReading | null>();

function rememberReading(fragment: string, reading: CampaignAssistReading | null): void {
  memo.delete(fragment); // re-inserting moves it to the newest end of the Map's order
  memo.set(fragment, reading);
  while (memo.size > CAMPAIGN_NOTE_ASSIST_MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
}

function parseFragments(outputText: string): Map<number, unknown> {
  const byIndex = new Map<number, unknown>();
  if (!outputText.trim()) return byIndex;
  const parsed: unknown = JSON.parse(outputText);
  const rows = (parsed as { fragments?: unknown }).fragments;
  if (!Array.isArray(rows)) return byIndex;
  for (const row of rows) {
    const index = (row as { index?: unknown })?.index;
    if (typeof index === "number" && Number.isInteger(index)) byIndex.set(index, row);
  }
  return byIndex;
}

/**
 * Read the fragments the rules could not, and return a map from fragment to what it is.
 *
 * A fragment absent from the result simply stays unread — the caller shows it as the rep wrote it,
 * which is what it does today.
 */
export async function assistCampaignFragments(
  fragments: readonly string[],
): Promise<Map<string, CampaignAssistReading>> {
  const resolved = new Map<string, CampaignAssistReading>();
  const pending: string[] = [];

  for (const raw of fragments) {
    const fragment = raw.trim();
    if (!fragment || resolved.has(fragment)) continue;
    const cached = memo.get(fragment);
    if (cached !== undefined) {
      if (cached) resolved.set(fragment, cached);
      continue;
    }
    if (!pending.includes(fragment)) pending.push(fragment);
  }

  if (pending.length === 0 || !hasAiApiKey()) return resolved;

  const batch = pending.slice(0, MAX_SEGMENTS_PER_CALL);

  try {
    const { outputText } = await createOpenAiResponseText({
      input: JSON.stringify(batch.map((fragment, index) => ({ fragment, index }))),
      instructions: INSTRUCTIONS,
      purpose: "crm_campaign_note_fragments",
      text: TEXT_FORMAT,
    });

    const byIndex = parseFragments(outputText);
    for (const [index, fragment] of batch.entries()) {
      const reading = acceptAssistRow(fragment, byIndex.get(index));
      rememberReading(fragment, reading);
      if (reading) resolved.set(fragment, reading);
    }
  } catch (error) {
    // Logged, not thrown. A drill-down that shows the rep's own words is correct; one that 500s is
    // not, and this is a nicety on top of a page that already works without it.
    logError("Campaign note assist failed; the drill-down falls back to the rules' reading", {
      labels: {
        event: "crm_campaign_note_assist_failed",
        code: error instanceof PhoenixOpenAiError ? error.code : "unknown",
        fragments: batch.length,
      },
    });
  }

  return resolved;
}
