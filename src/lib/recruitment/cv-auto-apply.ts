// Recruitment / ATS — which AI-extracted CV fields may be written onto a candidate unattended.
//
// Why this exists: automated intake (WhatsApp/email) used to apply ONLY the identity triple
// (fullName/email/phone, via candidateIdentityFromCvFields) and park everything else in
// ats_candidate_cv_extractions.extracted_fields as a proposal for Talent Acquisition to review.
// But the review UI is reachable only from the two MANUAL paths — the create-from-CV bulk board
// and the per-candidate "re-run extraction" button — so nothing ever surfaced those proposals for
// an auto-intake candidate. In production that left 39 of 41 extractions unapplied and only 1 of 9
// WhatsApp candidates carrying a university or governorate, while the AI had in fact read all of
// them correctly. The data was paid for and invisible.
//
// This module decides, as a pure function, the conservative subset that is safe to apply with no
// human in the loop. Everything it declines still remains in extracted_fields for review.
//
// Deliberately pure (schema registry + plain types only, no DB/AI imports) so the rules are unit
// testable without touching Supabase or OpenAI.

import { getCvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import type { Candidate, UpdateCandidateInput } from "@/lib/recruitment/types";

/** The AI's per-field proposal shape, narrowed to what this decision needs. */
export type AutoApplyExtractedFields = Record<
  string,
  { value: string | boolean | number | Array<Record<string, unknown>> | null; confidence: "high" | "low" }
>;

// The identity triple — fullName, email, phone — is createCandidate's alone. It resolves identity
// BEFORE the candidate row exists (choosing between the CV's identity and the sender's, per
// identitySource) and derives the national_id_norm/email_norm/phone_norm dedupe keys from the
// result. Re-applying it here would at best be redundant, and at worst would rewrite the identity
// of an EXISTING candidate that intake matched rather than created — silently repointing someone
// else's record.
//
// Of that triple, only the two DEDUPE-DECIDING keys are permanently off-limits to an unattended
// write. fullName and email are what createCandidate matched on; rewriting either really can
// repoint one person's record at another.
//
// `phone` is different, and blanket-excluding it cost more than it protected. Email intake takes
// identity from the SENDER, and a sender's address carries no phone number — so an emailed CV
// creates a candidate with phone NULL, the AI reads the real mobile off the CV, and that number
// then sits unread in ats_candidate_cv_extractions and never reaches the column anyone dials.
// Measured in production 2026-08-15: the AI had read a phone for 162 of the 172 extracted
// candidates, and 134 of them still showed a blank phone (113 of those at high confidence) — a pool
// of people nobody could ring.
//
// Phone is therefore allowed, under one EXTRA gate on top of the four below: only when this intake
// CREATED the candidate. On a MATCH the original hazard is real (the matched record's identity was
// resolved by a different CV entirely), so a matched candidate still waits for a human. That gate
// costs nothing measurable — all 113 high-confidence production cases came from candidate_created,
// none from candidate_matched.
const AUTO_APPLY_NEVER_KEYS: ReadonlySet<string> = new Set(["fullName", "email"]);
const AUTO_APPLY_ON_CREATE_ONLY_KEYS: ReadonlySet<string> = new Set(["phone"]);

// Columns that must hold ONE number somebody can dial, not whatever the CV had under "Contact".
const PHONE_SHAPED_KEYS: ReadonlySet<string> = new Set(["phone", "whatsapp"]);

// An Egyptian mobile is 11 digits (01xxxxxxxxx); with a country code it reaches 12 (+201…) or 13
// (00201… minus the leading zero pair, or a foreign number). 14 is legitimate only in the 0020…
// international form. Nothing real is longer.
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 13;
const PHONE_DOUBLE_ZERO_EGYPT = "0020";

/**
 * Whether a proposed value is ONE phone number rather than several run together.
 *
 * This gate exists because the confidence gate cannot catch this class at all. A CV whose contact
 * line reads "01060464699 & 01112872565" produces a perfectly HIGH-confidence extraction — the AI
 * is not wrong, it faithfully transcribed what the page said. The result is a 22-digit string that
 * is not a phone number.
 *
 * Writing one is worse than leaving the column blank, and asymmetrically so. `phone_norm` carries a
 * partial UNIQUE index that nothing maintains but the app writer, so the junk value goes straight
 * into the dedupe index; a later genuine application from either of those two real numbers then
 * fails to match, and the record is unreachable by the one thing that identifies it. A blank column,
 * by contrast, costs nothing permanent — the value stays in `extracted_fields` for a human to split
 * by hand.
 *
 * Measured on production 2026-08-16: 8 of 42 high-confidence phones were two or three numbers run
 * together, up to 32 digits ("+91-7002466900/9085277771/7002031980"). Same rule the phone backfill
 * used, so the shipped gate and the two hand-run backfills now agree.
 *
 * Deliberately conservative at the top end: a valid but unusually long international number is
 * declined rather than written. Declining leaves a recoverable gap; writing poisons an index.
 */
export function isSingleDiallablePhone(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS) return true;
  return digits.length === PHONE_MAX_DIGITS + 1 && digits.startsWith(PHONE_DOUBLE_ZERO_EGYPT);
}

/**
 * A candidate column counts as free to fill only when it currently holds nothing.
 *
 * Booleans are the subtle case: `false` is a real, deliberate answer ("no prior work experience"),
 * not an absence, so only null/undefined count as blank. Treating false as blank would let a later
 * extraction flip a recorded "no" to "yes".
 */
export function isBlankCandidateValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

/**
 * The subset of a CV extraction that may be written to the candidate unattended.
 *
 * Five gates, each of which exists to make the unattended write boring:
 *   1. confidence === "high" — the AI's own hedge is respected; "low" always waits for a human.
 *      Repeating blocks are the one exception: they carry no per-entry confidence (an employer row
 *      either came off the CV or it did not), so the array branch below skips this gate.
 *   2. storage === "column" OR type === "array" — a scalar goes to its own ats_candidates column;
 *      a repeating block merges into position_specific_fields, a different write shape with
 *      different merge semantics, handled by its own branch below. Anything that is neither is
 *      still declined.
 *   3. not a dedupe-deciding identity field (fullName/email), and — for phone — only when this
 *      intake created the candidate. See AUTO_APPLY_NEVER_KEYS / AUTO_APPLY_ON_CREATE_ONLY_KEYS.
 *   4. the column is currently blank — this only ever FILLS gaps, never overwrites. So a value a
 *      human typed, or one an earlier extraction already applied, always wins over a later
 *      proposal. That is what makes the feature safe to run on every inbound CV. For blocks the
 *      same rule applies at block granularity: an edited work history is never re-extracted over.
 *   5. a phone-shaped column holds ONE diallable number. This is the only gate that judges the
 *      value rather than its provenance, because it is the only failure the other four cannot see:
 *      a two-number contact line is transcribed correctly, at high confidence, into a column that
 *      is legitimately blank. See isSingleDiallablePhone.
 *
 * Empty and null proposals are dropped, which also disposes of the schema's `showWhen` dependents
 * for free: the extraction instructions require medicalRepEmployer and the experience dates to be
 * null unless hasMedicalRepExperience is true, so a dependent with nothing to say never arrives.
 *
 * The declared field `type` is enforced against the runtime value, so a malformed model response
 * cannot put a string into a boolean column.
 *
 * Returns an empty object when there is nothing to do — the caller can skip the write entirely.
 */
export function selectAutoApplyFields(input: {
  extractedFields: AutoApplyExtractedFields | null | undefined;
  positionKey: string;
  candidate: Pick<Candidate, keyof Candidate & string> | Record<string, unknown>;
  /**
   * True when the calling intake CREATED this candidate rather than matching an existing one.
   * Gates AUTO_APPLY_ON_CREATE_ONLY_KEYS (phone). Defaults to false, so any caller that cannot
   * prove the candidate is new keeps the old, stricter behaviour.
   */
  candidateWasCreatedByThisIntake?: boolean;
}): UpdateCandidateInput {
  const schema = getCvPositionSchema(input.positionKey);
  if (!schema || !input.extractedFields) return {};

  const applied: Record<string, string | boolean | number> = {};
  const blocks: Record<string, unknown> = {};
  const existingBlocks =
    ((input.candidate as Record<string, unknown>).positionSpecificFields as Record<string, unknown> | undefined) ?? {};

  for (const definition of schema.fields) {
    if (AUTO_APPLY_NEVER_KEYS.has(definition.key)) continue;
    if (AUTO_APPLY_ON_CREATE_ONLY_KEYS.has(definition.key) && !input.candidateWasCreatedByThisIntake) continue;

    const proposal = input.extractedFields[definition.key];
    if (!proposal) continue;

    // Repeating blocks (gate 2's "jsonb" branch, deliberately designed as of 2026-08-14).
    //
    // These carry no per-entry confidence — an employer row either came off the CV or it did not —
    // so the confidence gate does not apply. The blank gate still does, at block granularity: a
    // block is written only when the candidate has nothing under that key yet, so a human who has
    // edited the work history is never overwritten by a re-extraction. Without this, blocks would
    // reach `extracted_fields` and stop there — this function is the only path that moves a
    // non-column field onto the candidate.
    if (definition.type === "array") {
      const value = proposal.value;
      if (!Array.isArray(value) || value.length === 0) continue;
      const current = existingBlocks[definition.key];
      if (Array.isArray(current) && current.length > 0) continue;
      // Entries are filtered on the way IN, not only on the way out. Every read path
      // (normalizeStoredExtractionFields, buildReviewBoardFields, the review board itself) drops
      // non-object entries, so a malformed one persisted here would be saved to
      // position_specific_fields and then be invisible everywhere it could be corrected.
      const entries = value.filter(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      );
      if (entries.length === 0) continue;
      blocks[definition.key] = entries;
      continue;
    }

    if (definition.storage !== "column") continue;
    if (proposal.confidence !== "high") continue;

    const value = proposal.value;
    if (value === null || value === undefined) continue;
    // A scalar column never takes an array. Every declared type below already rejects one (an
    // array fails each `typeof` check), so this is not a new rule — it is the same rule stated
    // where the compiler can see it, since `definition.type` cannot narrow `value` on its own.
    // The `type === "array"` branch above has already consumed the legitimate arrays; anything
    // reaching here with one is a malformed or hand-edited proposal.
    if (Array.isArray(value)) continue;
    if (definition.type === "boolean" && typeof value !== "boolean") continue;
    if (definition.type === "number" && typeof value !== "number") continue;
    // "date" values are YYYY-MM-DD strings, so they share the string check.
    if ((definition.type === "string" || definition.type === "date") && typeof value !== "string") continue;
    if (typeof value === "string" && value.trim().length === 0) continue;
    // Gate 5: a phone column takes one diallable number or nothing. High confidence is not enough
    // here — see isSingleDiallablePhone for why a faithful transcription can still be unusable.
    if (PHONE_SHAPED_KEYS.has(definition.key) && !isSingleDiallablePhone(value)) continue;

    if (!isBlankCandidateValue((input.candidate as Record<string, unknown>)[definition.key])) continue;

    applied[definition.key] = typeof value === "string" ? value.trim() : value;
  }

  if (Object.keys(blocks).length > 0) {
    (applied as Record<string, unknown>).positionSpecificFields = { ...existingBlocks, ...blocks };
  }

  return applied as UpdateCandidateInput;
}
