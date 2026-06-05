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

  // Rule 5/6 — new screening stages are present and non-terminal.
  for (const stage of ["shortlisted", "on_hold", "no_response", "call_back"]) {
    assert.ok((applicationStages as readonly string[]).includes(stage), `missing stage ${stage}`);
    assert.equal(isTerminalApplicationStage(stage), false, `${stage} must be non-terminal`);
  }

  // Rule 5/6 — screening + hold/resume actions exist.
  for (const action of [
    "app_cv_shortlist",
    "app_shortlist_to_scheduling",
    "app_hold",
    "app_resume_from_hold_to_cv",
    "app_resume_from_hold_to_phone",
    "app_no_response",
    "app_resume_from_no_response",
    "app_call_back",
    "app_resume_from_call_back_to_cv",
    "app_resume_from_call_back_to_phone",
  ]) {
    assert.ok((recruitmentActionKeys as readonly string[]).includes(action), `missing action ${action}`);
  }

  // Rule 8/9 — interview completion + final-selection stages (non-terminal).
  for (const stage of ["manager_interview_completed", "backup_candidate"]) {
    assert.ok((applicationStages as readonly string[]).includes(stage), `missing stage ${stage}`);
    assert.equal(isTerminalApplicationStage(stage), false, `${stage} must be non-terminal`);
  }
  for (const action of [
    "app_mgr_completed_to_final",
    "app_resume_from_hold_to_hm",
    "app_to_backup",
    "app_backup_to_offer",
  ]) {
    assert.ok((recruitmentActionKeys as readonly string[]).includes(action), `missing action ${action}`);
  }

  // Offer pipeline — staged stages (non-terminal) + actions.
  for (const stage of ["offer_draft", "offer_pending_approval", "offer_approved", "offer_generated", "offer_negotiation"]) {
    assert.ok((applicationStages as readonly string[]).includes(stage), `missing stage ${stage}`);
    assert.equal(isTerminalApplicationStage(stage), false, `${stage} must be non-terminal`);
  }
  for (const action of [
    "app_offer_prepare",
    "app_offer_submit_approval",
    "app_offer_approved",
    "app_offer_approval_rejected",
    "app_offer_generated",
    "app_offer_negotiation",
  ]) {
    assert.ok((recruitmentActionKeys as readonly string[]).includes(action), `missing action ${action}`);
  }
}
