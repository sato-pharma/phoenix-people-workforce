import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  assertContractWorkflowTransition,
  assertProbationWorkflowTransition,
  assertResignationWorkflowTransition,
  toProbationWorkflowStatus,
} from "../src/lib/employee-lifecycle/workflow.ts";
import { WorkflowRegistryTransitionError } from "../src/lib/workflow-registry/service.ts";
import { registryModuleRow, withPostgrestStandIn } from "./support/postgrest-stand-in.ts";

// REC-079 (phase 2): src/lib/employee-lifecycle — the one translator between the resignation,
// probation and contract records and the Workflow Registry — run, not read.
//
// Each lifecycle module stores its own status words ("approved", "manager_feedback", a probation
// "decision"); the registry speaks a namespaced vocabulary ("resignation_approved"). This file maps one
// to the other and asks the registry, against the registry rows held in the shared in-memory
// PostgREST. Its main rule, asserted below:
//
//   1. A transition the registry allows is allowed; one it does not — wrong status, wrong role, an
//      action it never defined, or a destination that disagrees with the caller's — is refused BEFORE
//      the caller writes anything, and a module with no registry row fails CLOSED.
//   2. A probation decision outranks its status ("pass" is passed whatever the status says), and the
//      retired "extend" decision maps to no extended status — the owner removed that path.
//   3. A resignation or contract action with no caller is judged as the system (the Super Admin),
//      and a new record is judged from the registry's "new" state, never from a stored status.

const registry = () => ({
  workflow_registry_modules: [
    registryModuleRow("resignations", [
      { from: ["resignation_new"], key: "resignation_submit", roles: ["Super Admin", "HR Operations"], to: "resignation_submitted" },
      { from: ["resignation_submitted", "resignation_under_review"], key: "resignation_approve", roles: ["Super Admin"], to: "resignation_approved" },
      { from: ["resignation_approved"], key: "resignation_complete", roles: ["Super Admin"], to: "resignation_completed" },
    ]),
    registryModuleRow("probation", [
      { from: ["probation_new"], key: "probation_create", roles: ["Super Admin", "HR Operations"], to: "probation_evaluation_requested" },
      { from: ["probation_manager_feedback"], key: "probation_pass", roles: ["Super Admin"], to: "probation_passed" },
    ]),
    registryModuleRow("contracts", [
      { from: ["contract_new"], key: "contract_create", roles: ["Super Admin"], to: "contract_requested" },
      { from: ["contract_requested"], key: "contract_manager_review", roles: ["Super Admin"], to: "contract_manager_review" },
    ]),
  ],
});

const refusedBy = (reason: string) => (error: unknown) => error instanceof WorkflowRegistryTransitionError && error.reason === reason;

export async function runEmployeeLifecycleWorkflowBehaviourTests(): Promise<void> {
  // ── 2. A probation decision outranks its status; "extend" is gone ──────────────────────────────
  assert.equal(toProbationWorkflowStatus({ decision: "pass", status: "manager_feedback" }), "probation_passed", "a pass decision is passed whatever the status says");
  assert.equal(toProbationWorkflowStatus({ decision: " TERMINATE ", status: "evaluation_requested" }), "probation_terminated");
  assert.equal(
    toProbationWorkflowStatus({ decision: "extend", status: "manager_feedback" }),
    "probation_manager_feedback",
    "HEADLINE: the retired extend decision maps to no extended status — the record stays where its status puts it",
  );
  assert.equal(toProbationWorkflowStatus({ status: "completed" }), "probation_passed");
  assert.equal(toProbationWorkflowStatus({ status: "cancelled" }), "probation_cancelled");
  assert.equal(toProbationWorkflowStatus({}), "probation_evaluation_requested", "no status at all is the first stage, never a decided one");

  await withPostgrestStandIn({ tables: registry() }, async (seen) => {
    // ── 1. Allowed is allowed; everything else is refused before the caller writes ──────────────
    await assertResignationWorkflowTransition({ action: "complete", expectedNextStatus: "resignation_completed", status: "approved" });
    await assertResignationWorkflowTransition({ action: "approve", status: " Under_Review " });
    await assert.rejects(
      assertResignationWorkflowTransition({ action: "complete", status: "submitted" }),
      refusedBy("workflow_status_not_allowed"),
      "HEADLINE: a resignation cannot be completed from submitted — the registry refuses it",
    );
    const hrOps = createAccessContext({ hrId: "HR-9", loginId: "hr.nine", role: "HR Operations", source: "session" });
    await assert.rejects(
      assertResignationWorkflowTransition({ access: hrOps, action: "complete", status: "approved" }),
      (error: Error) => /^Forbidden: Workflow Registry does not allow HR Operations to run resignations\.resignation_complete/.test(error.message),
      "a role the registry does not name is refused with the standard Forbidden",
    );
    await assert.rejects(
      assertResignationWorkflowTransition({ action: "reject", status: "submitted" }),
      refusedBy("workflow_action_not_found"),
      "an action the registry never defined is refused",
    );
    await assert.rejects(
      assertResignationWorkflowTransition({ action: "complete", expectedNextStatus: "resignation_cancelled", status: "approved" }),
      refusedBy("workflow_next_status_mismatch"),
      "a caller expecting a different destination than the registry's is refused",
    );

    // ── 3. A new record starts from the registry's "new" state, and no caller means the system ──
    await assert.doesNotReject(
      assertResignationWorkflowTransition({ action: "submit", status: "approved" }),
      "HEADLINE: a new resignation is judged from the registry's new state, never from a status already stored on the row",
    );
    await assertResignationWorkflowTransition({ access: hrOps, action: "submit", status: null });
    await assertProbationWorkflowTransition({ access: hrOps, action: "create", status: "completed" });
    await assertContractWorkflowTransition({ action: "manager_review", status: null });
    await assert.rejects(
      assertContractWorkflowTransition({ action: "manager_review", status: "renewed" }),
      refusedBy("workflow_status_not_allowed"),
      "a renewed contract is not sent back to manager review",
    );
    // A probation decision is judged from the stage its decision puts it in, so a pass on a record
    // whose status still says feedback is judged as passed, and a pass from passed is not allowed.
    await assertProbationWorkflowTransition({
      access: createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin", source: "session" }),
      action: "pass",
      status: "manager_feedback",
    });
    await assert.rejects(
      assertProbationWorkflowTransition({
        access: createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin", source: "session" }),
        action: "pass",
        decision: "pass",
        status: "manager_feedback",
      }),
      refusedBy("workflow_status_not_allowed"),
      "a probation already decided pass is not passed a second time",
    );

    assert.equal(seen.filter((entry) => entry.kind === "write" || entry.kind === "rpc").length, 0, "asking the registry writes nothing");
  });

  // ── 1b. A module with no registry row fails closed ─────────────────────────────────────────────
  await withPostgrestStandIn({ tables: { workflow_registry_modules: [] } }, async () => {
    await assert.rejects(
      assertResignationWorkflowTransition({ action: "complete", status: "approved" }),
      refusedBy("workflow_module_not_found"),
      "HEADLINE: with no resignations row in the registry, completing a resignation is refused — never allowed by default",
    );
  });
}
