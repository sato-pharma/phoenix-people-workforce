import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applicationStageLabel,
  applicationStageLabels,
  humanizeRecruitmentTerm,
  requisitionStatusLabel,
  requisitionStatusLabels,
} from "../src/lib/recruitment/labels.ts";
import { applicationStages, requisitionStatuses } from "../src/lib/recruitment/types.ts";

/**
 * Pins the two ways a stored recruitment code used to reach a person's screen as a database value.
 *
 * Both were live on production on 24 Aug 2026, on the values the database actually holds:
 *   - the requisition badge read "REQ FILLED" and "REQ OPEN" — the `req_` namespace rendered as a
 *     word, when the only sensible reading is "Filled" and "Open";
 *   - the pipeline read "Hr Interview" and the interview list read "Cv", because the old helper
 *     upper-cased the first letter of every word and had no idea an acronym existed.
 */
export function runRecruitmentLabelTests() {
  // ---------------------------------------------------------------------------
  // The headline: the exact strings that were on screen.
  // ---------------------------------------------------------------------------
  assert.equal(requisitionStatusLabel("req_filled"), "Filled", "the req_ namespace must never reach a badge");
  assert.equal(requisitionStatusLabel("req_open"), "Open", "the req_ namespace must never reach a badge");
  assert.equal(applicationStageLabel("hr_interview"), "HR interview", "HR is an acronym, not the word 'Hr'");
  assert.equal(applicationStageLabel("cv_screening"), "CV screening", "CV is an acronym, not the word 'Cv'");
  assert.equal(humanizeRecruitmentTerm("cv"), "CV", "the interview type 'cv' rendered as 'Cv'");
  assert.equal(humanizeRecruitmentTerm("hr"), "HR", "the interview type 'hr' would render as 'Hr'");

  // ---------------------------------------------------------------------------
  // No code in either vocabulary may render as a raw or half-cooked value.
  // ---------------------------------------------------------------------------
  for (const status of requisitionStatuses) {
    const label = requisitionStatusLabel(status);
    assert.ok(label.length > 0, `${status} must have a label`);
    assert.ok(!label.includes("_"), `${status} rendered with an underscore: ${label}`);
    assert.ok(!/^Req\b/i.test(label), `${status} kept its namespace: ${label}`);
  }
  for (const stage of applicationStages) {
    const label = applicationStageLabel(stage);
    assert.ok(label.length > 0, `${stage} must have a label`);
    assert.ok(!label.includes("_"), `${stage} rendered with an underscore: ${label}`);
    assert.ok(!/\bHr\b|\bCv\b/.test(label), `${stage} mangled an acronym: ${label}`);
  }

  // Every code in the canonical list has an entry — a stage added to types.ts without a label here
  // would otherwise fall through to the humanizer silently.
  for (const status of requisitionStatuses) {
    assert.ok(status in requisitionStatusLabels, `${status} is missing from requisitionStatusLabels`);
  }
  for (const stage of applicationStages) {
    assert.ok(stage in applicationStageLabels, `${stage} is missing from applicationStageLabels`);
  }

  // ---------------------------------------------------------------------------
  // The fallback still has to behave for codes with no fixed vocabulary.
  // ---------------------------------------------------------------------------
  assert.equal(humanizeRecruitmentTerm("phone_screening"), "Phone screening", "ordinary codes still humanize");
  assert.equal(humanizeRecruitmentTerm("offer_sent"), "Offer sent", "sentence case, not Title Case");
  assert.equal(humanizeRecruitmentTerm(""), "", "empty in, empty out");
  assert.equal(humanizeRecruitmentTerm(null), "", "null must not render as 'Null'");
  assert.equal(humanizeRecruitmentTerm(undefined), "", "undefined must not render as 'Undefined'");
  // An acronym is spelled the same wherever it lands in the phrase, first word or not.
  assert.equal(humanizeRecruitmentTerm("sfe_manager"), "SFE manager", "a leading acronym keeps its case");
  assert.equal(humanizeRecruitmentTerm("interview_with_hr"), "Interview with HR", "a trailing acronym keeps its case");

  // An unknown code degrades to something readable rather than to a raw value — and a req_ code
  // this file has not been taught still loses the namespace.
  assert.equal(requisitionStatusLabel("req_archived"), "Archived", "an untaught req_ code still loses its prefix");
  assert.equal(applicationStageLabel("some_new_stage"), "Some new stage", "an untaught stage still reads as prose");

  // ---------------------------------------------------------------------------
  // The old helper must not come back. It is a one-line regex that looks harmless in review, so
  // the guard is on the workspace file rather than on anyone's memory of why it was removed.
  // ---------------------------------------------------------------------------
  const workspace = readFileSync("src/components/recruitment/recruitment-workspace.tsx", "utf8");
  assert.ok(
    !/function titleCase\(/.test(workspace),
    "recruitment-workspace.tsx reintroduced its own titleCase — use src/lib/recruitment/labels.ts",
  );
  assert.ok(
    !/titleCase\(/.test(workspace),
    "recruitment-workspace.tsx still calls titleCase somewhere",
  );
}
