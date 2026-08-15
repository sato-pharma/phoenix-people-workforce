// Recruitment / ATS — did the CV actually get READ?
//
// Until this module existed there was no such question. extractCvFieldsFromBytes made one AI call
// and returned whatever came back: a full profile and an empty shell were the same "success", so a
// garbled read was written to the audit trail, auto-applied nothing, and nobody ever found out.
// Measured in production 2026-08-15: 226 candidates, 226 CV files, 177 extractions — 49 CVs
// (46 of them from July) that nobody and nothing ever read, with intake_errors sitting at zero.
//
// Pure on purpose (no pdf-parse, no OpenAI, no Supabase) so the escalation rule can be tested
// directly and so cv-extraction-fields.ts's client importers stay unaffected.

import type { ExtractedCandidateFields, ExtractedCvValue, ExtractedField } from "@/lib/recruitment/cv-extraction-fields";

// The fields a genuinely-read CV almost always yields. Chosen from measured production fill rates
// rather than from taste: across the 177 completed extractions these sat at 86–100%, so a miss
// here means the DOCUMENT was not read, not that the applicant lacks the fact. Deliberately NOT
// included: linkedinUrl (0%), expectedSalary (0%), nationalId (4%), gender (7%) — all of which are
// genuinely absent from most CVs and would make every normal read look like a failure.
export const CORE_CV_SIGNAL_KEYS = [
  "fullName",
  "email",
  "phone",
  "currentJobTitle",
  "professionalSummary",
  "degree",
  "university",
  "workHistory",
  "educationHistory",
] as const;

// Below this many core signals, the read is not credible enough to accept as final. Three is
// deliberately generous: a one-page CV with no education section still clears it on name + phone +
// work history. What does NOT clear it is the shape a failed read takes — a name and nothing else,
// or a page marker parsed as a document.
export const MIN_CORE_CV_SIGNALS = 3;

export type CvExtractionScore = {
  /** Core signal keys (of CORE_CV_SIGNAL_KEYS) that came back with a value. */
  coreFilled: number;
  /** Every schema field that came back with a value, core or not. */
  filled: number;
  /** Of those, how many the model was willing to call "high". */
  highConfidence: number;
  /** Core keys that came back empty — the human-readable half of the score. */
  missingCore: string[];
  /** Whether the model produced a name at all. */
  hasName: boolean;
};

function hasValue(field: ExtractedField<ExtractedCvValue> | undefined): boolean {
  if (!field) return false;
  const value = field.value;
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/**
 * Counts what an extraction actually produced. Never throws on a malformed/partial field map —
 * a garbled reply is precisely the input this has to survive in order to report on it.
 */
export function scoreCvExtraction(fields: ExtractedCandidateFields | null | undefined): CvExtractionScore {
  const map = fields ?? {};
  let filled = 0;
  let highConfidence = 0;
  for (const field of Object.values(map)) {
    if (!hasValue(field)) continue;
    filled += 1;
    if (field.confidence === "high") highConfidence += 1;
  }

  const missingCore: string[] = [];
  let coreFilled = 0;
  for (const key of CORE_CV_SIGNAL_KEYS) {
    if (hasValue(map[key])) coreFilled += 1;
    else missingCore.push(key);
  }

  return { coreFilled, filled, hasName: hasValue(map.fullName), highConfidence, missingCore };
}

/**
 * The escalation rule: is this read too thin to accept without a second opinion?
 *
 * Two independent failures, either of which is enough:
 *  - fewer than MIN_CORE_CV_SIGNALS core signals, the shape of a garbled or empty read; or
 *  - no name at all. Every CV in existence carries the applicant's name, so an extraction that
 *    produced none did not read the document — and a nameless candidate is exactly the record that
 *    later gets named after whoever emailed it.
 */
export function isThinCvRead(score: CvExtractionScore): boolean {
  return score.coreFilled < MIN_CORE_CV_SIGNALS || !score.hasName;
}

function betterField(
  primary: ExtractedField<ExtractedCvValue> | undefined,
  fallback: ExtractedField<ExtractedCvValue> | undefined,
): ExtractedField<ExtractedCvValue> | undefined {
  const primaryHas = hasValue(primary);
  const fallbackHas = hasValue(fallback);
  if (!fallbackHas) return primary;
  if (!primaryHas) return fallback;

  // Both answered. A longer repeating block is strictly more information — a second pass that
  // found four jobs where the first found one read the layout better, whatever it says about its
  // own confidence.
  if (Array.isArray(primary!.value) && Array.isArray(fallback!.value)) {
    return fallback!.value.length > primary!.value.length ? fallback : primary;
  }

  // Otherwise confidence decides, and the FIRST pass wins a tie: the retry runs on a rendered
  // image of the same document, which reads layout better but small print worse.
  if (primary!.confidence === "high") return primary;
  if (fallback!.confidence === "high") return fallback;
  return primary;
}

/**
 * Best-of merge across two reads of the SAME document, field by field. Used when a thin text-layer
 * read is escalated to the vision route: the retry usually recovers the fields the flattened text
 * lost, but it must never be allowed to discard what the first pass already got right.
 */
export function mergeCvExtractions(
  primary: ExtractedCandidateFields,
  fallback: ExtractedCandidateFields,
): ExtractedCandidateFields {
  const merged: ExtractedCandidateFields = {};
  for (const key of new Set([...Object.keys(primary), ...Object.keys(fallback)])) {
    const chosen = betterField(primary[key], fallback[key]);
    if (chosen) merged[key] = chosen;
  }
  return merged;
}
