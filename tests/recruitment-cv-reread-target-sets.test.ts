// Recruitment / ATS — the re-read script's "rules-only" set must mean ONLY rules, not "rules once".
//
// The incident this pins, 2026-08-27. scripts/recruitment-reread-never-read-cvs.ts built its
// rules-only set from "has a free rules row somewhere in its history". That is a different question
// from the one the set is named for, and a much larger answer: a re-read INSERTS a new row rather
// than replacing the old one, so every candidate the model read still carried the free row from the
// attempt before it and stayed in the set permanently.
//
// Measured live on production (ozucdzovmcqvepbozvqf) that day, immediately after the whole corpus
// had been re-read:
//
//     has a rules row anywhere ........ 174
//     ...of those, ALSO a model row ... 174
//     genuinely rules-only ............   0
//     candidates with a model read .... 432 of 432
//
// So the script reported a 174-CV backlog that did not exist, and printed beside it "they need a
// real key — pass --include-rules-only to read them". Nothing was ever re-read wrongly: those ids
// are all in readIds, so they were already out of the target set and the accompanying `held back 0`
// was correct. The defect was the NUMBER and the advice — a tool confidently recommending spend on
// work already done, to a session with no cheap way to check. This repo's expensive failures are
// that shape far more often than they are a wrong action.
//
// The logic lives in src/lib/recruitment/cv-reread-target-sets.ts precisely so these can be real
// behavioural assertions. The script itself calls main() at import time against production and can
// never be imported by a test; the source-shape pins in recruitment-reread-model-constants.test.ts
// are all it can carry, and a shape pin cannot see that a set answers the wrong question.

import assert from "node:assert/strict";

import { OCR_EXTRACTION_MODEL, RULE_ONLY_EXTRACTION_MODEL } from "../src/lib/recruitment/cv-extraction.ts";
import {
  type CvExtractionModelRow,
  selectNewestIsRulesCandidateIds,
  selectReadCandidateIds,
  selectRulesOnlyCandidateIds,
} from "../src/lib/recruitment/cv-reread-target-sets.ts";

const RULES_ONLY_MODELS = new Set<string>([RULE_ONLY_EXTRACTION_MODEL, OCR_EXTRACTION_MODEL]);

// Oldest-first, exactly as the script's paginated fetch orders them.
const row = (candidate: string, model: string): CvExtractionModelRow => ({
  candidate_id: candidate,
  ai_model: model,
});

export function runRecruitmentCvRereadTargetSetsTests() {
  // --- 1. THE HEADLINE. A rules row followed by a model read is NOT rules-only ------------------
  // This is the production shape: every one of the 174 looked exactly like this.
  const reread: CvExtractionModelRow[] = [
    row("read-later", RULE_ONLY_EXTRACTION_MODEL),
    row("read-later", "gpt-5.4-nano"),
  ];
  assert.deepEqual(
    [...selectRulesOnlyCandidateIds(reread, RULES_ONLY_MODELS)],
    [],
    "a candidate whose free rules row was followed by a real model read is NOT rules-only — counting it there is what reported 174 CVs of work that was already done, and advised paying to redo it",
  );
  assert.ok(
    selectReadCandidateIds(reread, RULES_ONLY_MODELS).has("read-later"),
    "a candidate with a model row must count as read",
  );

  // --- 2. ...and order must not rescue it. Model first, rules after, still not rules-only -------
  // A re-read that fell back to the free engine leaves the rows the other way round. The set is
  // about whether a model EVER read it, so both orderings must answer the same.
  assert.deepEqual(
    [...selectRulesOnlyCandidateIds(
      [row("fell-back", "gpt-5.4-nano"), row("fell-back", RULE_ONLY_EXTRACTION_MODEL)],
      RULES_ONLY_MODELS,
    )],
    [],
    "row order must not decide membership — subtracting readIds is order-independent, a de-dupe on the newest row would not be",
  );

  // --- 3. A genuinely unread candidate is still collected ---------------------------------------
  // The fix must not empty the set. This is the case the hold-back exists for.
  const neverRead: CvExtractionModelRow[] = [
    row("only-rules", RULE_ONLY_EXTRACTION_MODEL),
    row("only-rules", RULE_ONLY_EXTRACTION_MODEL),
    row("only-ocr", OCR_EXTRACTION_MODEL),
  ];
  assert.deepEqual(
    [...selectRulesOnlyCandidateIds(neverRead, RULES_ONLY_MODELS)].sort(),
    ["only-ocr", "only-rules"],
    "a candidate the model has never read must stay in the rules-only set, or restoring the key would silently skip exactly the CVs that were read worst",
  );
  assert.equal(
    selectReadCandidateIds(neverRead, RULES_ONLY_MODELS).size,
    0,
    "free rules and OCR rows are not model reads",
  );

  // --- 4. A hybrid row is a MODEL read -----------------------------------------------------------
  // "gpt-5.4-nano+rules" is what the model writes when the rules filled its gaps. It carries the
  // model's name because the cost is attributable to it, and it is the most common shape in the
  // table — 174 of 432 candidates carry one. Reading it as free output would resurrect the bug.
  const hybrid = [row("hybrid", "gpt-5.4-nano+rules")];
  assert.deepEqual(
    [...selectRulesOnlyCandidateIds(hybrid, RULES_ONLY_MODELS)],
    [],
    "a '+rules' hybrid is a read the model did and was billed for, not free rules output",
  );
  assert.ok(selectReadCandidateIds(hybrid, RULES_ONLY_MODELS).has("hybrid"));

  // --- 5. The newest-row set is DELIBERATELY different and must stay so -------------------------
  // It may include an already-read candidate: a model read that happened once and badly, then fell
  // back to rules, is the highest-value re-read there is. Collapsing the two sets would lose that.
  const fellBack = [row("fell-back", "gpt-5.4-nano"), row("fell-back", RULE_ONLY_EXTRACTION_MODEL)];
  assert.ok(
    selectNewestIsRulesCandidateIds(fellBack, RULES_ONLY_MODELS).has("fell-back"),
    "--newest-rules-only must still reach a candidate whose newest row is free rules output, even though a model read it earlier",
  );
  assert.equal(
    selectRulesOnlyCandidateIds(fellBack, RULES_ONLY_MODELS).size,
    0,
    "the two sets answer different questions and must not converge",
  );
  assert.ok(
    !selectNewestIsRulesCandidateIds(
      [row("then-read", RULE_ONLY_EXTRACTION_MODEL), row("then-read", "gpt-5.4-nano")],
      RULES_ONLY_MODELS,
    ).has("then-read"),
    "newest-row must read the LAST row per candidate, not any row",
  );

  // --- 6. The production shape end to end -------------------------------------------------------
  // 174 re-read candidates and 258 model-only ones, the corpus as it stood after the 2026-08-27 run.
  // Before the fix this asserted 174; the true answer is 0, and no candidate is held back.
  const corpus: CvExtractionModelRow[] = [];
  for (let i = 0; i < 174; i++) {
    corpus.push(row(`c${i}`, RULE_ONLY_EXTRACTION_MODEL));
    corpus.push(row(`c${i}`, "gpt-5.4-nano+rules"));
  }
  for (let i = 174; i < 432; i++) corpus.push(row(`c${i}`, "gpt-5.4-nano"));
  assert.equal(
    selectReadCandidateIds(corpus, RULES_ONLY_MODELS).size,
    432,
    "every candidate in the corpus has been read by a model",
  );
  assert.equal(
    selectRulesOnlyCandidateIds(corpus, RULES_ONLY_MODELS).size,
    0,
    "with the whole corpus model-read, the rules-only backlog is zero — reporting 174 here is the regression",
  );
}
