// Recruitment / ATS — who counts as "already read" when deciding which CVs to re-read.
//
// These three sets used to be built inline in scripts/recruitment-reread-never-read-cvs.ts, which
// calls main() at import time against production. Nothing that self-invokes can be imported by a
// test, so the only checks the script could carry were source-shape pins — and a source pin cannot
// tell you that a set answers the WRONG QUESTION, only that it still looks the way it looked. One
// of them did answer the wrong question for as long as it existed; see selectRulesOnlyCandidateIds.
//
// The rows are extraction rows from ats_candidate_cv_extractions. `ai_model` is `unknown` on
// purpose: it arrives from PostgREST as JSON, and every caller coerces it the same way.

export type CvExtractionModelRow = {
  candidate_id: string;
  ai_model: unknown;
};

const modelOf = (row: CvExtractionModelRow) => String(row.ai_model ?? "");

/**
 * Candidates the MODEL has read at least once, ever.
 *
 * A read is attributed to whatever did it: Phoenix's own free engine stamps `ai_model` with its own
 * name ("phoenix-rules", "phoenix-rules+ocr"), while a read the model did carries the MODEL's name —
 * "gpt-5.4-nano", or the model plus a "+rules" suffix when the rules filled the gaps. So "not one of
 * the free names" is the discriminator, and a hybrid row counts as a real read, because it is one.
 */
export function selectReadCandidateIds(
  rows: readonly CvExtractionModelRow[],
  rulesOnlyModels: ReadonlySet<string>,
): Set<string> {
  return new Set(
    rows.filter((row) => !rulesOnlyModels.has(modelOf(row))).map((row) => String(row.candidate_id)),
  );
}

/**
 * Candidates whose extraction history is free rules output and NOTHING ELSE.
 *
 * The fix, 2026-08-27. This set was built from "has a rules row somewhere in its history", which is
 * a different question and a much larger answer: a candidate the model reads today still carries the
 * free row from the attempt before it, so it stayed in this set for ever after. Measured live on
 * production the same day it read **174** while the true count was **0** — every one of the 174 also
 * had a model row.
 *
 * Nothing was ever re-read wrongly because of it. Every id it over-collected is by definition also in
 * readIds, so those candidates were already out of the target set and the hold-back's own
 * `held back 0` was accurate. What was wrong was the NUMBER and the sentence printed beside it,
 * which advised passing --include-rules-only to "read them" — 174 CVs of spend, for candidates that
 * were already read, recommended by the tool itself to a session with no cheap way to check. That is
 * the failure mode this repo keeps paying for: not a wrong action, a confident wrong reading that
 * invites one. The flag could not have acted on them either way, so the advice was doubly hollow.
 *
 * Subtracting readIds is the whole fix, and it makes the name true.
 */
export function selectRulesOnlyCandidateIds(
  rows: readonly CvExtractionModelRow[],
  rulesOnlyModels: ReadonlySet<string>,
): Set<string> {
  const read = selectReadCandidateIds(rows, rulesOnlyModels);
  return new Set(
    rows
      .filter((row) => rulesOnlyModels.has(modelOf(row)))
      .map((row) => String(row.candidate_id))
      .filter((candidateId) => !read.has(candidateId)),
  );
}

/**
 * Candidates whose NEWEST row is a free rules row, whatever came before it.
 *
 * Distinct from the set above and deliberately so: this one CAN include a candidate the model has
 * read, and that is the point — a model read that happened once and badly, then fell back to rules,
 * is exactly the CV worth spending on again. `rows` must arrive oldest-first; the last write per
 * candidate wins.
 */
export function selectNewestIsRulesCandidateIds(
  rows: readonly CvExtractionModelRow[],
  rulesOnlyModels: ReadonlySet<string>,
): Set<string> {
  const newestModelByCandidate = new Map<string, string>();
  for (const row of rows) newestModelByCandidate.set(String(row.candidate_id), modelOf(row));
  return new Set(
    [...newestModelByCandidate.entries()]
      .filter(([, model]) => rulesOnlyModels.has(model))
      .map(([candidateId]) => candidateId),
  );
}
