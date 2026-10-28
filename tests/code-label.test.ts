import assert from "node:assert/strict";

import { codeOrWords, humanizeCode } from "../src/lib/format/code-label.ts";
import { requestStatusLabel } from "../src/lib/approvals-hub/request-status-label.ts";
import { humanizeOutstationCode } from "../src/lib/outstation/description-format.ts";
import { humanize } from "../src/lib/marketing-requests/request-report-columns.ts";
import { applicationStageLabel, humanizeRecruitmentTerm, requisitionStatusLabel } from "../src/lib/recruitment/labels.ts";

// Names, never codes (AGENTS.md §4). One rule turns a stored code into words — humanizeCode — and the
// domains that own a label function keep it; a code they do not name falls back to this one.
export function runCodeLabelTests() {
  // humanizeCode: sentence case, acronyms keep their spelling, empty gives "".
  assert.equal(humanizeCode("pending_manager"), "Pending manager");
  assert.equal(humanizeCode("ceo_approved"), "CEO approved");
  assert.equal(humanizeCode("kpi-review"), "KPI review");
  assert.equal(humanizeCode("hr_return"), "HR return");
  assert.equal(humanizeCode("  needs_assignment "), "Needs assignment");
  assert.equal(humanizeCode(""), "");
  assert.equal(humanizeCode(null), "");
  assert.equal(humanizeCode(undefined), "");
  assert.ok(!/_/.test(humanizeCode("a_b_c")), "an underscore never survives");

  // codeOrWords: words already written for people are kept exactly; only a code is turned into words.
  assert.equal(codeOrWords("Short day"), "Short day");
  assert.equal(codeOrWords("Late"), "Late");
  assert.equal(codeOrWords("pending_hr"), "Pending HR");
  assert.equal(codeOrWords("performed"), "Performed");
  assert.equal(codeOrWords(""), "");
  assert.equal(codeOrWords(null), "");

  // requestStatusLabel: a request status outside its module.
  assert.equal(requestStatusLabel("pending_hr"), "Waiting for HR");
  assert.equal(requestStatusLabel("PENDING_MANAGER"), "Waiting for manager");
  assert.equal(requestStatusLabel("performed"), "Done");
  assert.equal(requestStatusLabel("Late"), "Late", "attendance words keep their own wording");
  assert.equal(requestStatusLabel("ceo_approved"), "CEO approved", "an unnamed code is humanised, never shown raw");
  assert.equal(requestStatusLabel(null), "");

  // The domain humanisers fall back to the shared rule for a code they do not name, and a label they
  // already returned is unchanged.
  assert.equal(humanizeOutstationCode("manager_review"), "Manager review");
  assert.equal(humanizeOutstationCode("car"), "Car");
  assert.equal(humanizeOutstationCode("hr_review"), "HR review", "an unnamed code with an acronym is spelled the house way");
  assert.equal(humanizeOutstationCode("Already words"), "Already words");
  assert.equal(humanizeOutstationCode(""), null);
  assert.equal(humanize("pending_validation"), "Pending validation");
  assert.equal(humanize("ceo_approved"), "CEO approved");
  assert.equal(humanize(null), null);
  assert.equal(requisitionStatusLabel("req_filled"), "Filled", "a named recruitment code keeps its own label");
  assert.equal(applicationStageLabel("hr_interview"), "HR interview");
  assert.equal(humanizeRecruitmentTerm("phone_screening"), "Phone screening");
}
