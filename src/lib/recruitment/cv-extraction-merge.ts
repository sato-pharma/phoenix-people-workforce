// Recruitment / ATS — the seam between the free rule engine and the paid AI pass.
//
// This file encodes the owner's instruction of 2026-08-19: rules FIRST as the primary path, AI
// SECOND as an enhancement on top of the result — not the other way round, which is how CV
// extraction became the most expensive thing in the system.
//
// It answers two questions, and keeping them separate is the whole design:
//
//   1. shouldEscalateToAi()  — is the rule result good enough on its own? If it is, no request is
//      made and the CV costs nothing. This is the actual cost lever.
//   2. mergeCvExtractions()  — given both results, which value wins per field?
//
// The merge policy is NOT "newest wins" or "AI wins". It is per-field, because the two engines are
// good at genuinely different things:
//
//   • DETERMINISTIC fields (email, phone, LinkedIn, national ID, governorate) — the RULE wins,
//     always, even against a high-confidence AI answer. A regex that matched a real address is not
//     improved by a model's opinion of it, and a model that "corrects" a phone number it misread
//     from a two-column layout produces a candidate nobody can call. Measured: email 98%,
//     mobile 93% on the real careers inbox.
//   • VERBATIM fields (professional summary) — the RULE wins, because the value's worth is that it
//     is the candidate's own words. A model paraphrases, which destroys exactly what the field is
//     for.
//   • JUDGEMENT fields (work history, current title/employer, years of experience) — the AI wins
//     when it answers at high confidence, because these need reading comprehension the rules
//     openly do not have.
//
// Isomorphic and dependency-free (no AI client, no DB) so it can be unit-tested directly and
// imported from either side of the pipeline.

import type { ExtractedCandidateFields, ExtractedCvValue, ExtractedField } from "@/lib/recruitment/cv-extraction-fields";
import { isThinCvRead, scoreCvExtraction } from "@/lib/recruitment/cv-extraction-quality";
import type { RuleExtractionResult } from "@/lib/recruitment/rule-extraction";

/** Which engine a merged value came from — recorded so a wrong field can be traced to its source. */
export type CvFieldSource = "rule" | "ai";

export type MergedCvExtraction = {
  readonly fields: ExtractedCandidateFields;
  /** Per field key, the engine whose value survived the merge. */
  readonly sources: Readonly<Record<string, CvFieldSource>>;
  readonly fromRule: number;
  readonly fromAi: number;
};

/**
 * Fields the rule engine owns outright. An AI value never overwrites a rule value here — it is only
 * used when the rules found nothing at all.
 */
export const RULE_AUTHORITATIVE_FIELDS: readonly string[] = [
  "email",
  "phone",
  "whatsapp",
  "linkedinUrl",
  "nationalId",
  "governorate",
  "professionalSummary",
];

/**
 * Fields where a confident AI answer beats a rule answer.
 *
 * Every one of these is a reading-comprehension task the rule engine performs by structural
 * inference and marks "low" — pairing an employer to a date range, telling a current title from an
 * applied-for one, summing overlapping employment periods.
 */
export const AI_PREFERRED_FIELDS: readonly string[] = [
  "workHistory",
  "educationHistory",
  "currentJobTitle",
  "currentEmployer",
  "currentRoleResponsibilities",
  "yearsExperience",
  "appliedForJobTitle",
  "hasMedicalRepExperience",
  "medicalRepEmployer",
  "medicalRepExperienceFrom",
  "medicalRepExperienceTo",
];

function isEmpty(field: ExtractedField<ExtractedCvValue> | undefined): boolean {
  if (!field) return true;
  const { value } = field;
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Combines a rule extraction with an AI extraction under the per-field policy above.
 *
 * Either side may be absent: merging with an empty AI result returns the rule result unchanged,
 * which is exactly what happens on the no-AI path.
 *
 * NOT to be confused with `mergeCvExtractions` in cv-extraction-quality.ts. That one merges two
 * reads of the same document by the SAME engine (the text pass and its vision retry) and picks the
 * richer answer. This one arbitrates between two DIFFERENT engines whose strengths are known in
 * advance, which is why it is a fixed per-field policy rather than a best-of.
 */
export function mergeRuleAndAiExtractions(
  ruleFields: ExtractedCandidateFields,
  aiFields: ExtractedCandidateFields = {},
): MergedCvExtraction {
  const fields: ExtractedCandidateFields = {};
  const sources: Record<string, CvFieldSource> = {};

  for (const key of new Set([...Object.keys(ruleFields), ...Object.keys(aiFields)])) {
    const rule = ruleFields[key];
    const ai = aiFields[key];
    const ruleEmpty = isEmpty(rule);
    const aiEmpty = isEmpty(ai);

    if (ruleEmpty && aiEmpty) continue;
    if (aiEmpty) {
      fields[key] = rule!;
      sources[key] = "rule";
      continue;
    }
    if (ruleEmpty) {
      fields[key] = ai!;
      sources[key] = "ai";
      continue;
    }

    // Both engines answered.
    if (RULE_AUTHORITATIVE_FIELDS.includes(key)) {
      fields[key] = rule!;
      sources[key] = "rule";
      continue;
    }
    if (AI_PREFERRED_FIELDS.includes(key)) {
      // Still only when the model is confident — a low-confidence AI guess must not displace a
      // value a rule actually read from the page.
      const takeAi = ai!.confidence === "high" || rule!.confidence === "low";
      fields[key] = takeAi ? ai! : rule!;
      sources[key] = takeAi ? "ai" : "rule";
      continue;
    }

    // Everything else: the more confident answer wins, and the rule wins a tie. A tie means both
    // engines read the same thing off the page, so the free one is preferred.
    const takeAi = ai!.confidence === "high" && rule!.confidence === "low";
    fields[key] = takeAi ? ai! : rule!;
    sources[key] = takeAi ? "ai" : "rule";
  }

  const values = Object.values(sources);
  return {
    fields,
    fromAi: values.filter((source) => source === "ai").length,
    fromRule: values.filter((source) => source === "rule").length,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Deciding whether to spend anything at all
// ---------------------------------------------------------------------------

/**
 * The fields worth paying a model for.
 *
 * Note what is NOT here: email, phone, LinkedIn, governorate, skills, languages, degree, university,
 * graduation year. The rules find those at 69-100% and an AI call cannot improve on a regex that
 * matched an exact address — asking about them is the pure waste this whole module exists to stop.
 */
export const AI_WORTH_ASKING_FIELDS: readonly string[] = [
  "fullName",
  "currentJobTitle",
  "currentEmployer",
  "workHistory",
  "yearsExperience",
  "currentRoleResponsibilities",
];

export type EscalationDecision = {
  readonly escalate: boolean;
  readonly reason: string;
  /** The subset of fields still unanswered — what an AI pass should be asked to fill. */
  readonly missingFields: readonly string[];
};

/**
 * Whether this CV needs the paid pass at all.
 *
 * Deliberately conservative in the direction of NOT spending: the rule result is already a complete,
 * reviewable candidate record, and a human sees every low-confidence value in the review board
 * regardless. Escalation is for documents the rules genuinely could not read — a CV with no
 * parseable work history, or one where the text layer had to be repaired and may still be wrong.
 */
export function shouldEscalateToAi(result: RuleExtractionResult): EscalationDecision {
  const missingFields = AI_WORTH_ASKING_FIELDS.filter((key) => isEmpty(result.fields[key]));

  if (!result.isCv) {
    return { escalate: false, missingFields, reason: "not a CV — nothing to extract" };
  }
  // Reuses the production-calibrated thinness rule rather than inventing a second opinion about
  // what a failed read looks like: fewer than MIN_CORE_CV_SIGNALS core fields, or no name at all.
  // A thin rule read is the clearest case for spending money — the document defeated the rules.
  if (isThinCvRead(scoreCvExtraction(result.fields))) {
    return { escalate: true, missingFields, reason: "rule read is too thin to accept (core signals missing)" };
  }
  if (result.repairedText) {
    return { escalate: true, missingFields, reason: "text layer needed repair; rule reading may be incomplete" };
  }
  if (missingFields.length === 0) {
    return { escalate: false, missingFields, reason: "rules answered every field worth asking about" };
  }
  if (missingFields.length >= 3) {
    return { escalate: true, missingFields, reason: `${missingFields.length} judgement fields unanswered by rules` };
  }
  return { escalate: false, missingFields, reason: `only ${missingFields.length} field(s) missing — not worth a model call` };
}
