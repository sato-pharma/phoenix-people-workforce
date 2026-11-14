import {
  createOpenAiResponseText,
  hasAiApiKey,
  OPENAI_ROUTE_BUDGET_MS,
} from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/ai/parse-ai-json";
import {
  diceCoefficient,
  jaccardSimilarity,
  nameTokens,
  resolvePharmacyMatchConfidence,
} from "@/lib/pharmacy-master/pharmacy-matching";
import { foldCustomerName } from "@/lib/customer-master/name-key";
import {
  DEFAULT_VENUE_TYPE,
  venueRequiresDistributorCode,
  venueTypeLabel,
  type VenueType,
} from "@/lib/venues/venue-type";

// ─────────────────────────────────────────────────────────────────────────────
// Read the storefront evidence (spec E2).
//
// A Super Admin deciding a validation sees a claimed name, a GPS distance and a photo, and has to
// judge the photo unaided. This reads it once, at filing, so the answer is already on the desk.
//
// IT ADVISES. IT NEVER DECIDES. The rule is stated in this module's sibling — AREA_PROXIMITY_FLAG_KM
// in pharmacy-validation.ts — and it holds for exactly the same reason:
//
//   "This is a FLAG, never an automatic rejection … a hard gate would reject real pharmacies …
//    producing exactly the 'the new system blocked everything' complaint the whole design exists
//    to avoid."
//
// A real Egyptian pharmacy may have a handwritten sign, an Arabic-only sign, no sign at all, or a
// sign behind a parked truck. Every one of those is a reason for a human to look, not a verdict.
// Nothing in the decide path reads this, and a test asserts that stays true.
//
// UNKNOWN IS NOT A PASS. `isPharmacy` is true | false | null, and null is returned freely. The
// failure that matters here is a confident "yes" on a photo of a kiosk, so the prompt is written to
// prefer null over a guess — the same rule B5's invoice reader uses for a code it cannot make out.
//
// Invisible by rule (spec D4): nothing this module produces names a model, and the confidence
// number it stores is for later analysis, never for display.
// ─────────────────────────────────────────────────────────────────────────────

export type DirectOrderEvidenceCheck = {
  /** null means "could not tell" — never render or treat it as "no". */
  isPharmacy: boolean | null;
  /** What the sign actually reads, verbatim, in whatever script it is written in. */
  signText: string | null;
  /** Whether that sign is the pharmacy the rep claimed. null when either side is unreadable. */
  signMatchesClaim: boolean | null;
  /** 0–1 from the existing pharmacy matcher. Stored for analysis; NOT shown (spec D4). */
  similarity: number | null;
  /** One sentence a Super Admin can act on. */
  note: string | null;
  checkedAt: string;
};

/**
 * WHAT THE MODEL IS ASKED depends on what the venue CLAIMS to be, and until 2026-08-29 it did
 * not. Every photograph was judged against "is this a PHARMACY specifically — not a clinic,
 * hospital, supermarket, kiosk, warehouse, or general shop", which is the correct question for
 * the 44 pharmacies and precisely the wrong one for the 8 venues registered as a nursery. A
 * clinic photographed by a rep who filed it, correctly, as a nursery was being judged by a
 * question written to REJECT clinics — and the desk then rendered the answer as a red
 * "This does not look like a pharmacy." over evidence that was never wrong.
 *
 * A wrong verdict is worse than a clumsy label: an approver reads it as a finding.
 */
const PHARMACY_INSTRUCTIONS =
  "You are looking at a photograph taken by a pharmaceutical sales representative standing in " +
  "front of what they say is a pharmacy in Egypt. Report only what the photograph shows. " +
  "Say whether the building is a PHARMACY specifically — not a clinic, hospital, supermarket, " +
  "kiosk, warehouse, or general shop. Transcribe the shop sign exactly as written, in its own " +
  "script (Arabic signs stay in Arabic; do not translate or transliterate). " +
  "If the sign is unreadable, obscured, cut off, absent, or you are not confident, return null " +
  "rather than guessing. A null answer is expected and useful; a confident wrong answer is not, " +
  "because a real pharmacy would be doubted on the strength of it.";

/**
 * For a venue with no distributor account. The trade is deliberately NOT named: these are filed
 * as a nursery because nothing vouches for them commercially, and in practice they are nurseries,
 * clinics and doctors’ rooms alike — the owner files a direct-order-only clinic as a nursery
 * himself. So the question is whether this is a REAL PREMISES OF A BUSINESS, which is what the
 * photograph can actually answer, and the venue’s identity rests where the owner put it: on the
 * pin, the photograph, and the admin who looks at both.
 */
const NON_PHARMACY_INSTRUCTIONS =
  "You are looking at a photograph taken by a pharmaceutical sales representative standing in " +
  "front of a business in Egypt — a nursery, a clinic, a doctor's premises or similar. It is " +
  "NOT expected to be a pharmacy, and it must not be marked down for not being one. Report only " +
  "what the photograph shows. Say whether this looks like the real premises of a business at " +
  "all — a building, shop front, clinic or entrance with signage — rather than a private home, " +
  "an empty lot, a street with no premises in it, or a photograph of a screen or another photo. " +
  "Transcribe the sign exactly as written, in its own script (Arabic signs stay in Arabic; do " +
  "not translate or transliterate). If the sign is unreadable, obscured, cut off, absent, or " +
  "you are not confident, return null rather than guessing. A null answer is expected and " +
  "useful; a confident wrong answer is not, because a real business would be doubted on the " +
  "strength of it.";

const TEXT_FORMAT = {
  format: {
    name: "phoenix_storefront_evidence",
    schema: {
      additionalProperties: false,
      properties: {
        is_pharmacy: { type: ["boolean", "null"] as const },
        sign_text: { type: ["string", "null"] as const },
        note: { type: ["string", "null"] as const },
      },
      required: ["is_pharmacy", "sign_text", "note"],
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 && trimmed.toLowerCase() !== "null" ? trimmed : null;
}

/**
 * Does the sign read as the pharmacy the rep claimed?
 *
 * Uses the pharmacy master's own matcher rather than a fresh comparison: normalize (NFKD, strip
 * harakat and tatweel, unify alef/ya forms), then the same jaccard + dice pair that decides whether
 * two rows in the master are one pharmacy. A naive `===` on Arabic text disagrees with itself over
 * a hamza, and a second opinion on "is this the same pharmacy" is exactly the drift this codebase
 * keeps paying for.
 *
 * Returns null when either side is unusable — an empty claim or an unreadable sign is not a
 * mismatch, it is an absence, and the two must not be shown the same way.
 */
export function signMatchesClaimedName(
  signText: string | null,
  claimedName: string | null,
): { matches: boolean | null; similarity: number | null } {
  const sign = foldCustomerName(signText);
  const claim = foldCustomerName(claimedName);
  if (!sign || !claim) return { matches: null, similarity: null };

  const jaccard = jaccardSimilarity(nameTokens(signText), nameTokens(claimedName));
  const ratio = diceCoefficient(sign, claim);
  const confidence = resolvePharmacyMatchConfidence(jaccard, ratio);

  // Read the matcher's own vocabulary, which is NOT the obvious one — its doc comment is explicit:
  // "anything else with SOME signal → low; no signal at all → not a candidate (null)".
  //
  //   high / medium → the master would treat these as the same pharmacy → MATCHES
  //   null          → no signal whatsoever → two different names → DOES NOT MATCH
  //   low           → some overlap but weak → genuinely ambiguous → say nothing
  //
  // The first version of this had `low` and `null` the wrong way round, which made a supermarket
  // sign on a pharmacy claim report as "unknown" — throwing away the single most useful thing this
  // check produces. `low` staying null is deliberate: a sign can legitimately carry a trading name
  // that overlaps the registered one, and the desk shows the sign text anyway.
  const matches =
    confidence === "high" || confidence === "medium" ? true : confidence === null ? false : null;

  return { matches, similarity: Math.round(Math.max(jaccard, ratio) * 100) / 100 };
}

/**
 * Read the photo. Returns null when no answer could be obtained AT ALL — which the caller stores as
 * null, meaning "no answer", never "passed".
 *
 * This function does not throw for an upstream failure. Its caller files a rep's evidence, and a
 * model being busy must never be able to stop that.
 */
export async function checkDirectOrderStorefrontEvidence(input: {
  bytes: Buffer;
  claimedPharmacyName: string | null;
  /**
   * Defaults to `pharmacy` so every existing caller, and every row read back from before this
   * parameter existed, is judged by exactly the question it was judged by before.
   */
  venueType?: VenueType;
}): Promise<DirectOrderEvidenceCheck | null> {
  if (!hasAiApiKey()) return null;

  const venueType = input.venueType ?? DEFAULT_VENUE_TYPE;
  const isPharmacyVenue = venueRequiresDistributorCode(venueType);
  const instructions = isPharmacyVenue ? PHARMACY_INSTRUCTIONS : NON_PHARMACY_INSTRUCTIONS;
  const question = isPharmacyVenue
    ? "Is this a pharmacy, and what does its sign say?"
    : `Is this the real premises of a business, and what does its sign say? It is a ${venueTypeLabel(venueType).toLowerCase()}, not a pharmacy.`;

  try {
    const response = await createOpenAiResponseText({
      input: [
        {
          content: [
            { text: question, type: "input_text" as const },
            {
              // "high" detail: a shop sign is small text inside a wide street photo, and
              // downsampling is what turns a readable sign into a guess.
              detail: "high" as const,
              image_url: `data:image/jpeg;base64,${input.bytes.toString("base64")}`,
              type: "input_image" as const,
            },
          ],
          role: "user" as const,
        },
      ],
      instructions,
      // 1,500, not 500: on 25 Oct 2026 OpenAI refused its key, the call went to Claude, and Claude
      // stopped at 500 before closing the JSON (max_tokens) — the photo went unread. A long Arabic
      // sign plus a note needs the room; the cap only bounds a reply, it is not what one costs.
      maxOutputTokens: 1500,
      purpose: "direct-orders-storefront-evidence",
      reasoning: { effort: "low" },
      text: TEXT_FORMAT,
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
    });

    const parsed = parseAiJson(response.outputText);
    const signText = text(parsed.sign_text);
    const isPharmacy = typeof parsed.is_pharmacy === "boolean" ? parsed.is_pharmacy : null;
    const { matches, similarity } = signMatchesClaimedName(signText, input.claimedPharmacyName);

    return {
      checkedAt: new Date().toISOString(),
      isPharmacy,
      note: text(parsed.note),
      signMatchesClaim: matches,
      signText,
      similarity,
    };
  } catch {
    // Swallowed on purpose, and the caller logs it. There is no useful degraded answer here: a
    // partial verdict on evidence is worse than none, because the desk would show it as though it
    // had been read.
    return null;
  }
}
