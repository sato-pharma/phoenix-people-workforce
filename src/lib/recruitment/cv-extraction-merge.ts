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

import { type ExtractedCandidateFields, isEmptyExtractedField } from "@/lib/recruitment/cv-extraction-fields";
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
    const ruleEmpty = isEmptyExtractedField(rule);
    const aiEmpty = isEmptyExtractedField(ai);

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

/**
 * The two fields whose absence is worth a model call ON ITS OWN, without waiting for a count.
 *
 * Measured on production 2026-08-27, over the latest extraction of all 430 candidates. 97% of
 * rules-only candidates (149 of 154) had two or fewer of AI_WORTH_ASKING_FIELDS missing, so the
 * "3 or more" rule below never fired for them — the gate was working exactly as designed and the
 * pool simply sat under its line. But of the candidates missing exactly ONE field, that field was:
 *
 *   currentJobTitle              30
 *   currentEmployer              21
 *   currentRoleResponsibilities   6
 *   workHistory / yearsExperience / fullName   0
 *
 * So 57 candidates were one field short, and for 51 of them that field was the current title or
 * employer — core screening data for a medical-rep pipeline, and precisely the reading-comprehension
 * task the rules openly cannot do (both are in AI_PREFERRED_FIELDS, where a confident model answer
 * beats a rule answer outright: telling a current title from an applied-for one).
 *
 * The count rule alone cannot express that, because it weighs every field the same — a CV missing
 * only currentRoleResponsibilities and one missing only currentJobTitle were treated identically,
 * and they are not remotely equal in value. Lowering the threshold to 1 instead would have bought
 * the same 51 plus ~6 low-value calls; naming the fields buys only the 51.
 *
 * What it costs, on that same pool: 61 of the 154 rules-only candidates (40%) gain a model call —
 * 37 missing the title, 30 missing the employer, 6 missing both. Rules still run first and still
 * answer for free on the other 60%, so the ordering the owner set on 2026-08-19 is unchanged; this
 * only moves where the paid pass starts.
 */
export const HIGH_VALUE_ESCALATION_FIELDS: readonly string[] = ["currentJobTitle", "currentEmployer"];

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
 *
 * Two rules decide it, and the order matters:
 *
 *   VALUE  — any HIGH_VALUE_ESCALATION_FIELDS missing is worth a call by itself. Owner-approved
 *            2026-08-27 on the measurement in that constant's comment: 57 candidates sat one field
 *            short, and for 51 of them the field was the current title or employer.
 *   VOLUME — otherwise, 3 or more of AI_WORTH_ASKING_FIELDS missing. The original cost lever,
 *            unchanged.
 *
 * Value is checked first only for the clearer reason string; it cannot widen the gate, since
 * anything with 3+ missing escalates either way.
 */
export function shouldEscalateToAi(result: RuleExtractionResult): EscalationDecision {
  const missingFields = AI_WORTH_ASKING_FIELDS.filter((key) => isEmptyExtractedField(result.fields[key]));

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
  // Value before volume. Checked ahead of the count so that ONE missing high-value field is enough
  // on its own — see HIGH_VALUE_ESCALATION_FIELDS for the production measurement behind it. This
  // cannot loosen the gate below: a CV reaching here already has at least one field missing, and
  // anything with 3+ missing escalates on the next line regardless.
  const missingHighValue = missingFields.filter((key) => HIGH_VALUE_ESCALATION_FIELDS.includes(key));
  if (missingHighValue.length > 0) {
    return {
      escalate: true,
      missingFields,
      reason: `${missingHighValue.join(" and ")} unanswered by rules — worth a call on its own`,
    };
  }
  if (missingFields.length >= 3) {
    return { escalate: true, missingFields, reason: `${missingFields.length} judgement fields unanswered by rules` };
  }
  return { escalate: false, missingFields, reason: `only ${missingFields.length} field(s) missing — not worth a model call` };
}

/**
 * Of the fields the schema declares, the ones an AI answer could actually SURVIVE the merge on.
 *
 * The third cost lever, and the one that acts on output tokens rather than reasoning tokens.
 * `shouldEscalateToAi` decides *whether* to spend; `cvReasoningEffortForRoute` decides *how hard*
 * the model thinks; this decides *how much it is asked to write*. Until now an escalated CV was
 * asked for the entire ~30-field schema even though the rules had already won a third of it — and
 * every one of those answers was generated, billed, and then discarded by the policy above.
 *
 * The predicate is read straight off `mergeRuleAndAiExtractions`, branch for branch, so the two
 * cannot disagree about what is discardable:
 *
 *   • rule value empty            → ASK. An AI value is taken outright when the rules found nothing.
 *   • RULE_AUTHORITATIVE, filled  → DROP. The rule value wins unconditionally; the model's answer is
 *                                  thrown away on arrival. This is the pure waste.
 *   • AI_PREFERRED, filled        → ASK. A high-confidence answer beats the rule, and so does any
 *                                  answer where the rule itself was unsure.
 *   • anything else, filled       → ASK only if the rule was LOW. A high-confidence rule value can
 *                                  only be displaced by `ai high && rule low`, so with the rule
 *                                  already high there is no answer the model could give that wins.
 *
 * Callers must only use this when the rule pass actually read the document (a text layer, judged a
 * CV). With no rule result there is nothing won and nothing to narrow — ask for everything.
 */
export function aiFieldsWorthAsking(
  ruleFields: ExtractedCandidateFields,
  schemaFieldKeys: readonly string[],
): readonly string[] {
  return schemaFieldKeys.filter((key) => {
    const rule = ruleFields[key];
    if (isEmptyExtractedField(rule)) return true;
    if (RULE_AUTHORITATIVE_FIELDS.includes(key)) return false;
    if (AI_PREFERRED_FIELDS.includes(key)) return true;
    return rule!.confidence === "low";
  });
}
