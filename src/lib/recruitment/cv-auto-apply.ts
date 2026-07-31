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
export type AutoApplyExtractedFields = Record<string, { value: string | boolean | null; confidence: "high" | "low" }>;

// The identity triple is createCandidate's alone. It resolves identity BEFORE the candidate row
// exists (choosing between the CV's identity and the sender's, per identitySource) and derives the
// national_id_norm/email_norm/phone_norm dedupe keys from the result. Re-applying it here would at
// best be redundant, and at worst would rewrite the identity of an EXISTING candidate that intake
// matched rather than created — silently repointing someone else's record.
const IDENTITY_KEYS = new Set(["fullName", "email", "phone"]);

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
 * Four gates, each of which exists to make the unattended write boring:
 *   1. confidence === "high" — the AI's own hedge is respected; "low" always waits for a human.
 *   2. storage === "column" — only fields with a dedicated ats_candidates column. A future
 *      position's "jsonb" fields merge into position_specific_fields, a different write shape
 *      with different merge semantics, so they stay out until that path is deliberately designed.
 *   3. not an identity field — see IDENTITY_KEYS above.
 *   4. the column is currently blank — this only ever FILLS gaps, never overwrites. So a value a
 *      human typed, or one an earlier extraction already applied, always wins over a later
 *      proposal. That is what makes the feature safe to run on every inbound CV.
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
}): UpdateCandidateInput {
  const schema = getCvPositionSchema(input.positionKey);
  if (!schema || !input.extractedFields) return {};

  const applied: Record<string, string | boolean> = {};
  for (const definition of schema.fields) {
    if (definition.storage !== "column") continue;
    if (IDENTITY_KEYS.has(definition.key)) continue;

    const proposal = input.extractedFields[definition.key];
    if (!proposal || proposal.confidence !== "high") continue;

    const value = proposal.value;
    if (value === null || value === undefined) continue;
    if (definition.type === "boolean" && typeof value !== "boolean") continue;
    if (definition.type === "string" && typeof value !== "string") continue;
    if (typeof value === "string" && value.trim().length === 0) continue;

    if (!isBlankCandidateValue((input.candidate as Record<string, unknown>)[definition.key])) continue;

    applied[definition.key] = typeof value === "string" ? value.trim() : value;
  }

  return applied as UpdateCandidateInput;
}
