import assert from "node:assert/strict";

import {
  interviewOutcomes,
  interviewScorecardCriteria,
  isInterviewOutcome,
  normalizeScorecard,
  summarizeScorecard,
} from "../src/lib/recruitment/scorecards.ts";

export function runRecruitmentScorecardsTests() {
  // Criteria per interview type.
  assert.ok(interviewScorecardCriteria.hr.length >= 3, "HR criteria");
  assert.ok(interviewScorecardCriteria.hiring_manager.some((c) => c.key === "sales_skills"), "manager criteria");
  assert.ok(interviewScorecardCriteria.phone.length >= 1, "phone criteria");
  // Rule 5 — CV screening criteria.
  assert.equal(interviewScorecardCriteria.cv.length, 6, "cv has 6 criteria");
  assert.ok(interviewScorecardCriteria.cv.some((c) => c.key === "area_match"), "cv has area_match");

  // Normalize: keep valid 1-5 ratings for known criteria; drop everything else.
  const normalized = normalizeScorecard("hr", {
    communication: 7, // out of range -> dropped
    motivation: 3, // kept
    unknown_key: 5, // not a known criterion -> dropped
    professionalism: "abc", // non-numeric -> dropped
    stability: 0, // out of range -> dropped
    career_goals: 4, // kept
  });
  assert.deepEqual(normalized, { motivation: 3, career_goals: 4 });

  // Summary: average over rated criteria only.
  const summary = summarizeScorecard("hr", normalized);
  assert.equal(summary.totalCriteria, interviewScorecardCriteria.hr.length);
  assert.equal(summary.ratedCount, 2);
  assert.equal(summary.average, 3.5);

  const empty = summarizeScorecard("hr", {});
  assert.equal(empty.average, null);
  assert.equal(empty.ratedCount, 0);

  // Outcome guard.
  assert.equal(isInterviewOutcome("recommended"), true);
  assert.equal(isInterviewOutcome("banana"), false);
  for (const outcome of [
    "recommended",
    "rejected",
    "passed",
    "shortlisted",
    "need_phone_screening",
    "on_hold",
    "no_response",
    "call_back",
  ]) {
    assert.ok((interviewOutcomes as readonly string[]).includes(outcome), `outcome ${outcome}`);
  }
}
