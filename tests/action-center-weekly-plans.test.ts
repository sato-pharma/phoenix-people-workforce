import { strict as assert } from "node:assert";

import { ACTION_HUB_MODULE_LABELS, REJECTION_TEMPLATES } from "../src/components/action-center/types.ts";
import { resolveApproverPlanStage } from "../src/lib/weekly-planning/service.ts";

// The signed-in approver, expressed as the minimal access slice the rule reads.
const manager = { hrId: "A-9", role: "Marketing Manager", scope: "company" } as const;
const otherManager = { hrId: "B-3", role: "National Sales Manager", scope: "line" } as const;
const ceo = { hrId: "AA", role: "CEO", scope: "company" } as const;
const superAdmin = { hrId: "B-10", role: "Super Admin", scope: "system" } as const;
const stranger = { hrId: "Z-1", role: "Employee", scope: "self" } as const;

export function runActionCenterWeeklyPlansTests() {
  // Manager stage: only the assigned direct manager (case-insensitive HR_ID) sees a
  // freshly submitted plan awaiting review.
  assert.equal(resolveApproverPlanStage("submitted", "A-9", manager), "manager");
  assert.equal(resolveApproverPlanStage("submitted", "a-9", manager), "manager");
  assert.equal(resolveApproverPlanStage("submitted", "A-9", otherManager), null);
  assert.equal(resolveApproverPlanStage("submitted", "A-9", stranger), null);
  // A plan with no manager resolved never lands on a non-admin's queue.
  assert.equal(resolveApproverPlanStage("submitted", null, manager), null);

  // Super Admin is the manager-stage fallback (mirrors assertManagerReviewer) and sees
  // every submitted plan regardless of who the assigned manager is.
  assert.equal(resolveApproverPlanStage("submitted", "A-9", superAdmin), "manager");
  assert.equal(resolveApproverPlanStage("submitted", null, superAdmin), "manager");

  // CEO does NOT act at the manager stage…
  assert.equal(resolveApproverPlanStage("submitted", "A-9", ceo), null);
  // …but owns the CEO stage once the manager approved.
  assert.equal(resolveApproverPlanStage("manager_approved", "A-9", ceo), "ceo");
  assert.equal(resolveApproverPlanStage("manager_approved", "A-9", superAdmin), "ceo");
  // The assigned line manager never gets the CEO gate — that step is CEO/Super Admin only.
  assert.equal(resolveApproverPlanStage("manager_approved", "A-9", manager), null);

  // Closed / non-pending statuses never surface in the approver inbox, for anyone.
  for (const status of ["draft", "final_approved", "hr_acknowledged", "manager_rejected", "manager_returned", "cancelled"] as const) {
    assert.equal(resolveApproverPlanStage(status, "A-9", manager), null);
    assert.equal(resolveApproverPlanStage(status, "A-9", superAdmin), null);
    assert.equal(resolveApproverPlanStage(status, "A-9", ceo), null);
  }

  // The Action Center module registry must recognise weekly plans (these are exhaustive
  // Record<ActionHubModule, …> maps — a missing key would also fail typecheck).
  assert.equal(ACTION_HUB_MODULE_LABELS.weekly_plan, "Weekly Plan");
  assert.ok(Array.isArray(REJECTION_TEMPLATES.weekly_plan) && REJECTION_TEMPLATES.weekly_plan.length > 0);
}
