import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  canAccessWorkflowControlCenter,
  canEditWorkflowControlCenter,
  WORKFLOW_CONTROL_EDIT_ENABLED,
} from "../src/lib/auth/permissions.ts";
import {
  getWorkflowDefinition,
  listWorkflowDefinitions,
  workflowDefinitionKeys,
} from "../src/lib/workflow-control/definitions.ts";
import { simulateWorkflow } from "../src/lib/workflow-control/simulator.ts";

/**
 * Workflow Control Center (Phase 1) coverage: governance access, read-only
 * definitions, the simulator's routing/warnings, and the Phase-1 guarantees
 * (editing locked, no production-mutation calls in the read-only modules).
 */
export function runWorkflowControlTests() {
  // ---------------------------------------------------------------------------
  // Access control: only Super Admin + HR Specialist (HR governance).
  // ---------------------------------------------------------------------------
  assert.equal(canAccessWorkflowControlCenter({ role: "Super Admin" }), true, "Super Admin can access");
  assert.equal(canAccessWorkflowControlCenter({ role: "HR Specialist" }), true, "HR Specialist can access");
  for (const role of ["Medical Rep", "District Manager", "National Sales Manager", "Training Manager", "Finance Manager", "CEO", "Employee"] as const) {
    assert.equal(canAccessWorkflowControlCenter({ role }), false, `${role} must NOT access workflow control`);
  }

  // ---------------------------------------------------------------------------
  // Phase 1: editing is locked for everyone (incl. Super Admin).
  // ---------------------------------------------------------------------------
  assert.equal(WORKFLOW_CONTROL_EDIT_ENABLED, false, "Phase 1 editing flag is OFF");
  assert.equal(canEditWorkflowControlCenter({ role: "Super Admin" }), false, "no edit in Phase 1 even for Super Admin");
  assert.equal(canEditWorkflowControlCenter({ role: "HR Specialist" }), false, "no edit in Phase 1 for HR Specialist");

  // ---------------------------------------------------------------------------
  // Definitions: the required workflows are present.
  // ---------------------------------------------------------------------------
  const keys = workflowDefinitionKeys();
  for (const required of ["vacation", "expense", "outstation", "marketing", "probation", "contract", "offers", "resignation"]) {
    assert.ok(keys.includes(required), `definitions include "${required}"`);
  }
  // Bonus coverage requested by the business list.
  assert.ok(keys.includes("payroll"), "definitions include payroll/payslip notification");
  assert.ok(keys.includes("coaching"), "definitions include coaching");

  // Every step exposes notification + email recipient fields (arrays).
  for (const definition of listWorkflowDefinitions()) {
    assert.ok(definition.steps.length > 0, `${definition.key} has steps`);
    for (const step of definition.steps) {
      assert.ok(Array.isArray(step.notificationRecipients), `${definition.key}.${step.id} has notificationRecipients`);
      assert.ok(Array.isArray(step.emailRecipients), `${definition.key}.${step.id} has emailRecipients`);
    }
  }

  // Vacation specifically surfaces a manager-bound step and an HR-bound step.
  const vacation = getWorkflowDefinition("vacation");
  assert.ok(vacation, "vacation definition exists");
  assert.ok(
    vacation?.steps.some((s) => s.notificationRecipients.some((r) => /manager/i.test(r))),
    "vacation has a step notifying a manager",
  );
  assert.ok(
    vacation?.steps.some((s) => /hr/i.test(s.role) && /approved|rejected/i.test(s.statusProduced)),
    "vacation has an HR final-decision step",
  );

  // ---------------------------------------------------------------------------
  // Simulator: vacation routing.
  // ---------------------------------------------------------------------------
  const sim = simulateWorkflow({ workflowKey: "vacation", employeeHrId: "B-52", managerHrId: "A-99" });
  assert.equal(sim.found, true, "vacation simulation resolves");
  assert.ok(sim.steps.some((s) => /manager/i.test(s.routesTo)), "simulator routes a step to the direct manager");
  assert.ok(sim.steps.some((s) => /hr final decision/i.test(s.name)), "simulator includes the HR final decision step");
  assert.ok(/approved|rejected/i.test(sim.finalStatus), "vacation simulation ends at HR approve/reject");

  // Simulator warnings: missing manager and missing HR recipient.
  const missingManager = simulateWorkflow({ workflowKey: "vacation", employeeHrId: "B-52" });
  assert.ok(
    missingManager.warnings.some((w) => /manager/i.test(w)),
    "simulator warns when the direct manager is missing",
  );
  const missingHr = simulateWorkflow({ workflowKey: "vacation", employeeHrId: "B-52", managerHrId: "A-99", hrSpecialistAvailable: false });
  assert.ok(
    missingHr.warnings.some((w) => /hr/i.test(w)),
    "simulator warns when no HR Specialist recipient is configured",
  );

  // Unknown workflow degrades safely.
  const unknown = simulateWorkflow({ workflowKey: "does-not-exist" });
  assert.equal(unknown.found, false, "unknown workflow is not found");
  assert.ok(unknown.warnings.length > 0, "unknown workflow returns a warning, not a throw");

  // ---------------------------------------------------------------------------
  // Phase-1 guarantee: the read-only modules never call a mutation/DB path.
  // ---------------------------------------------------------------------------
  const simulatorSrc = readFileSync(new URL("../src/lib/workflow-control/simulator.ts", import.meta.url), "utf8");
  const definitionsSrc = readFileSync(new URL("../src/lib/workflow-control/definitions.ts", import.meta.url), "utf8");
  for (const src of [simulatorSrc, definitionsSrc]) {
    assert.equal(/getSupabaseAdmin|getSupabaseUserClient|enqueueInAppNotification|\.insert\(|\.update\(|\.delete\(/.test(src), false, "read-only module must not call any DB/mutation path");
    assert.equal(/@\/lib\/supabase\/server/.test(src), false, "read-only module must not import the supabase server client");
  }

  // ---------------------------------------------------------------------------
  // Wiring: map renders recipient fields; page enforces the governance gate.
  // ---------------------------------------------------------------------------
  const mapSrc = readFileSync(new URL("../src/components/workflow-control/workflow-map.tsx", import.meta.url), "utf8");
  assert.match(mapSrc, /notificationRecipients/, "map renders notification recipients");
  assert.match(mapSrc, /emailRecipients/, "map renders email recipients");

  const centerSrc = readFileSync(new URL("../src/components/workflow-control/workflow-control-center.tsx", import.meta.url), "utf8");
  assert.match(centerSrc, /Phase 2/, "edit panel communicates Phase 2 locking");
  assert.match(centerSrc, /read-only workflow map and simulator/i, "governance warning is present");

  const pageSrc = readFileSync(new URL("../app/admin/workflow-control/page.tsx", import.meta.url), "utf8");
  assert.match(pageSrc, /canAccessWorkflowControlCenter/, "page enforces the workflow-control access gate");
  assert.match(pageSrc, /redirect\("\/employee-portals"\)/, "page redirects unauthorized roles");
}
