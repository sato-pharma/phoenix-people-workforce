import assert from "node:assert/strict";

import {
  applicationStages,
  isTerminalApplicationStage,
  recruitmentActionKeys,
  requisitionStatuses,
  terminalApplicationStages,
} from "../src/lib/recruitment/types.ts";

function assertUnique(values: readonly string[], label: string) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

export function runRecruitmentPipelineStateMachineTests() {
  assertUnique(applicationStages, "application stages");
  assertUnique(requisitionStatuses, "requisition statuses");
  assertUnique(recruitmentActionKeys, "recruitment action keys");

  // Core stages exist.
  for (const stage of ["application_received", "in_candidate_pool", "offer_sent", "offer_accepted", "hired"]) {
    assert.ok((applicationStages as readonly string[]).includes(stage), `missing stage ${stage}`);
  }

  // Terminal stages are a subset of all stages and are recognised by the helper.
  for (const stage of terminalApplicationStages) {
    assert.ok((applicationStages as readonly string[]).includes(stage), `terminal ${stage} not in stages`);
    assert.ok(isTerminalApplicationStage(stage), `${stage} should be terminal`);
  }
  assert.equal(isTerminalApplicationStage("cv_screening"), false);
  assert.equal(isTerminalApplicationStage("hired"), true);

  // Requisition lifecycle endpoints exist.
  for (const status of ["req_draft", "req_open", "req_filled", "req_cancelled"]) {
    assert.ok((requisitionStatuses as readonly string[]).includes(status), `missing requisition status ${status}`);
  }

  // The offer-launch, reflection, and hire actions exist.
  for (const action of ["app_select", "app_offer_sent", "app_offer_accepted", "app_hire", "app_reject"]) {
    assert.ok((recruitmentActionKeys as readonly string[]).includes(action), `missing action ${action}`);
  }
}
