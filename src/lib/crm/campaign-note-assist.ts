/**
 * The cheap-model half of campaign-note reading: what the rules could not classify.
 *
 * `campaign-note.ts` settles most of the corpus for free — measured 2026-08-28 over all 17,474
 * distinct campaign notes on production, the rules name a person in 57.8% and a place in 24.3%, and
 * recognise a further 12.8% as the rep's own remark. What is left is **2,664 notes (15.2%)** that a
 * human reads instantly and a rule cannot:
 *
 *   "محمد الحويزي"            a bare name — a doctor, or the pharmacist who owns the shop?
 *   "م. طنطا العام"           an abbreviation for Tanta General Hospital
 *   "الجمعيه الشرعيه فالبيطاش"  a charity clinic, with its district inside its name
 *   "ص ثروت"                  "ص" is صيدلية — Tharwat Pharmacy
 *
 * The owner's instruction, 2026-08-28: *"you can use a cheap or free AI assist that already exists
 * in our code base to separate and analyse and extract the data."* So this uses the same
 * `gpt-5.4-nano` tier the rest of the app already runs on ($0.20/$1.25 per million in/out), on the
 * residue only — never on a note the rules already read, which is what keeps it cheap.
 *
 * TWO RULES CARRIED OVER FROM `campaign-account.ts`, AND NEITHER IS OPTIONAL.
 *
 * 1. **The model may choose and delimit; it may not author.** Every string it returns must occur
 *    inside the rep's own segment or it is dropped. Asked to find a doctor in a note that has none,
 *    a model will invent a plausible Egyptian name, and an invented doctor on a manager's board is
 *    worse than a blank — it looks like evidence.
 * 2. **The assist is invisible** (owner rule, ai-assist-invisible-to-users). No badge, no wording, no
 *    attribution reaches a user. Internal metrics still record the call, because hiding it is for
 *    users and not for the audit trail.
 *
 * It never throws. This runs inside a page render, so a missing key, a timeout or a malformed answer
 * must all degrade to "the rules' answer, unchanged".
 */

import { normalizeAccountText } from "@/lib/crm/campaign-account";
import { resolveSpeciality, type CampaignAccountKind, type CampaignNoteReading } from "@/lib/crm/campaign-note";
import { createOpenAiResponseText, hasOpenAiApiKey, PhoenixOpenAiError } from "@/lib/ai/openai-client";
import { logError } from "@/lib/observability/log";

/** Longer than this is the segment handed back, not a name pulled out of it. */
const MAX_NAME_LENGTH = 80;
/** Shorter than this identifies nobody ("د.", "ص", "hi"). */
const MIN_NAME_LENGTH = 3;
/** One page render covers a rep's month; this bounds a pathological one. */
const MAX_SEGMENTS_PER_CALL = 60;

const PLACE_KINDS: ReadonlyArray<CampaignAccountKind> = [
  "hospital",
  "clinic",
  "pharmacy",
  "laboratory",
  "medical centre",
  "company",
  "warehouse",
];

export type CampaignAssistReading =
  | { kind: "person"; name: string; speciality: string | null }
  | { kind: "place"; name: string; placeKind: CampaignAccountKind }
  | { kind: "remark" };

/**
 * Accept a model answer only when the rep actually wrote it.
 *
 * Pure and exported so the anti-fabrication guarantee is tested directly, with no network call.
 */
export function acceptAssistedValue(segment: string, candidate: string | null | undefined): string | null {
  const source = typeof segment === "string" ? segment.trim() : "";
  const answer = typeof candidate === "string" ? candidate.trim() : "";
  if (!source || !answer) return null;
  if (["null", "none", "n/a", "na", "-", "unknown"].includes(answer.toLowerCase())) return null;
  if (answer.length < MIN_NAME_LENGTH || answer.length > MAX_NAME_LENGTH) return null;
  if (!normalizeAccountText(source).includes(normalizeAccountText(answer))) return null;
  return answer;
}

/** Turn one raw model row into a reading, or null if it fails the gate. */
export function acceptAssistRow(segment: string, row: unknown): CampaignAssistReading | null {
  if (typeof row !== "object" || row === null) return null;
  const { kind, name, placeKind, speciality } = row as {
    kind?: unknown;
    name?: unknown;
    placeKind?: unknown;
    speciality?: unknown;
  };

  if (kind === "remark") return { kind: "remark" };

  const accepted = acceptAssistedValue(segment, typeof name === "string" ? name : null);
  if (!accepted) return null;

  if (kind === "person") {
    return {
      kind: "person",
      name: accepted,
      speciality: acceptAssistedValue(segment, typeof speciality === "string" ? speciality : null),
    };
  }

  if (kind === "place") {
    const resolved = PLACE_KINDS.find((value) => value === placeKind);
    // A place whose kind the model did not name is still a place the rep visited; "clinic" is the
    // least specific claim available and is preferred to dropping the row.
    return { kind: "place", name: accepted, placeKind: resolved ?? "clinic" };
  }

  return null;
}

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
 */
const memo = new Map<string, CampaignAssistReading | null>();

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

  if (pending.length === 0 || !hasOpenAiApiKey()) return resolved;

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
      memo.set(fragment, reading);
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

/**
 * Fold what the model read back into the rules' reading, in place of the fragments it explains.
 *
 * Order is preserved: a doctor the model recognised on line 3 stays third, because a campaign note
 * is a chronological list of a morning's calls and re-ordering it would misreport the day.
 */
export function applyAssist(
  reading: CampaignNoteReading,
  assisted: ReadonlyMap<string, CampaignAssistReading>,
): CampaignNoteReading {
  if (reading.unread.length === 0) return reading;

  const people = [...reading.people];
  const accounts = [...reading.accounts];
  const remarks = reading.remark ? [reading.remark] : [];
  const unread: string[] = [];

  for (const fragment of reading.unread) {
    const answer = assisted.get(fragment.trim());
    if (!answer) {
      unread.push(fragment);
      continue;
    }
    if (answer.kind === "person") {
      // Through the rules' own alias table, so a speciality the model spotted is canonicalised in
      // exactly one place — the model never gets to name a speciality the taxonomy does not hold.
      people.push({ name: answer.name, speciality: resolveSpeciality(answer.speciality) });
    } else if (answer.kind === "place") {
      accounts.push({ kind: answer.placeKind, name: answer.name });
    } else {
      remarks.push(fragment);
    }
  }

  return { accounts, people, remark: remarks.length > 0 ? remarks.join(" · ") : null, unread };
}
