import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  canAccessWorkflowControlCenter,
  canEditWorkflowControlCenter,
  WORKFLOW_CONTROL_EDIT_ENABLED,
} from "../src/lib/auth/permissions.ts";
import {
  domainGaps,
  domainHasNotificationGap,
  getWorkflowDomain,
  getWorkflowSubflow,
  listWorkflowDomains,
  subflowKeys,
  workflowDomainKeys,
} from "../src/lib/workflow-control/definitions.ts";
import { simulateWorkflow } from "../src/lib/workflow-control/simulator.ts";

/**
 * Workflow Control Center (Phase 1) coverage: governance access, the
 * business-friendly domain/subflow grouping, the simulator's routing/warnings,
 * and the Phase-1 guarantees (editing locked, no production-mutation calls).
 */
export function runWorkflowControlTests() {
  // ---------------------------------------------------------------------------
  // Access control: HR governance only = Super Admin. The HR Manager (B-10)
  // holds the Super Admin role and is covered. Generic HR Specialists (A-16)
  // are excluded.
  // ---------------------------------------------------------------------------
  assert.equal(canAccessWorkflowControlCenter({ role: "Super Admin", hrId: "B-10" }), true, "HR Manager (B-10, Super Admin) can access");
  assert.equal(canAccessWorkflowControlCenter({ role: "Super Admin", hrId: null }), true, "Super Admin can access");
  assert.equal(canAccessWorkflowControlCenter({ role: "HR Specialist", hrId: "A-16" }), false, "A-16 (HR Specialist) is NOT granted access");
  for (const role of ["Medical Rep", "District Manager", "National Sales Manager", "Training Manager", "Finance Manager", "CEO", "Employee"] as const) {
    assert.equal(canAccessWorkflowControlCenter({ role, hrId: "X-1" }), false, `${role} must NOT access workflow control`);
  }

  // Phase 1: editing locked for everyone.
  assert.equal(WORKFLOW_CONTROL_EDIT_ENABLED, false, "Phase 1 editing flag is OFF");
  assert.equal(canEditWorkflowControlCenter({ role: "Super Admin", hrId: "B-10" }), false, "no edit in Phase 1 even for Super Admin");

  // ---------------------------------------------------------------------------
  // Grouping: a few business-friendly top-level domains.
  // ---------------------------------------------------------------------------
  const domains = listWorkflowDomains();
  const domainKeys = workflowDomainKeys();
  assert.ok(domains.length <= 8, "top-level domains are few (<= 8)");

  // The required business domains exist.
  for (const required of ["leave", "expenses-outstation", "employee-lifecycle", "offer-hiring", "payroll", "coaching", "marketing", "notifications"]) {
    assert.ok(domainKeys.includes(required), `domain "${required}" exists`);
  }

  // Fragmented technical workflows are NOT top-level cards anymore.
  for (const notTopLevel of ["expense", "outstation", "vacation", "probation", "contract", "resignation", "payslip", "payroll-payslip", "offers"]) {
    assert.equal(domainKeys.includes(notTopLevel), false, `"${notTopLevel}" must NOT be a top-level domain`);
  }

  // Expenses & Outstation is ONE domain with Expense + Outstation as subflows.
  const expensesKeys = subflowKeys("expenses-outstation");
  assert.ok(expensesKeys.includes("expense"), "Standard expense is a subflow of Expenses & Outstation");
  assert.ok(expensesKeys.includes("outstation"), "Outstation travel is a subflow of Expenses & Outstation");

  // Payroll & Payslips contains payslip notification as a SUBFLOW, not a card.
  const payrollKeys = subflowKeys("payroll");
  assert.ok(payrollKeys.includes("payslip-notification"), "payslip notification is a subflow under Payroll & Payslips");
  assert.equal(domainKeys.some((k) => k.includes("payslip")), false, "no standalone Payslip Notification top-level card");

  // Employee Lifecycle contains Probation, Contract Renewal, Resignation.
  const lifecycleKeys = subflowKeys("employee-lifecycle");
  for (const sub of ["probation", "contract", "resignation"]) {
    assert.ok(lifecycleKeys.includes(sub), `Employee Lifecycle contains "${sub}" subflow`);
  }

  // Notifications & Communication is cross-cutting and does NOT duplicate flows.
  const notifications = getWorkflowDomain("notifications");
  assert.ok(notifications, "Notifications & Communication domain exists");
  assert.equal(notifications?.crossCutting, true, "Notifications domain is cross-cutting");
  const notifSubflowKeys = subflowKeys("notifications");
  assert.ok(notifSubflowKeys.length <= 5, "cross-cutting domain has few subflows (no workflow duplication)");
  for (const workflowish of ["vacation-request", "probation", "expense", "offer", "resignation"]) {
    assert.equal(notifSubflowKeys.includes(workflowish), false, `Notifications must not duplicate the "${workflowish}" workflow`);
  }

  // Every step is fully detailed: actor, role, status, recipient arrays, side effects.
  for (const domain of domains) {
    assert.ok(domain.subflows.length > 0, `${domain.key} has subflows`);
    for (const subflow of domain.subflows) {
      assert.ok(subflow.steps.length > 0, `${domain.key}/${subflow.key} has at least one step`);
      for (const step of subflow.steps) {
        const where = `${domain.key}/${subflow.key}/${step.id}`;
        assert.ok(step.actor && step.actor.length > 0, `${where} has an actor`);
        assert.ok(step.role && step.role.length > 0, `${where} has a responsible role`);
        assert.ok(step.statusProduced && step.statusProduced.length > 0, `${where} has a status produced`);
        assert.ok(Array.isArray(step.notificationRecipients), `${where} has notificationRecipients`);
        assert.ok(Array.isArray(step.emailRecipients), `${where} has emailRecipients`);
        assert.ok(step.sideEffects && step.sideEffects.length > 0, `${where} has side effects`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 1.5: notification gaps are surfaced where producers are missing.
  // ---------------------------------------------------------------------------
  const expenseSubmitStep = getWorkflowSubflow("expenses-outstation", "expense")?.steps.find((s) => s.id === "submit");
  assert.equal(expenseSubmitStep?.notificationGap, true, "expense submit is flagged as a notification gap");
  const payslipStep = getWorkflowSubflow("payroll", "payslip-notification")?.steps.find((s) => s.id === "publish");
  assert.equal(payslipStep?.notificationGap, true, "payslip publish is flagged as a notification gap");
  assert.equal(domainHasNotificationGap(getWorkflowDomain("expenses-outstation")!), true, "expenses domain has a notification gap");
  assert.equal(domainHasNotificationGap(getWorkflowDomain("leave")!), false, "leave domain has no notification gap (producers wired)");
  assert.ok(domainGaps(getWorkflowDomain("payroll")!).length > 0, "payroll domain surfaces open gaps");
  // The map renders the notification-gap and the action-required grouping.
  const mapGapSrc = readFileSync(new URL("../src/components/workflow-control/workflow-map.tsx", import.meta.url), "utf8");
  assert.match(mapGapSrc, /Notification gap: not implemented yet/, "map renders the notification-gap label");
  assert.match(mapGapSrc, /Action required/, "map renders the action-required recipient group");
  assert.match(mapGapSrc, /FYI/, "map renders the FYI recipient group");

  // ---------------------------------------------------------------------------
  // Simulator: domain + subflow selection (Leave / Vacation Request).
  // ---------------------------------------------------------------------------
  const sim = simulateWorkflow({ domainKey: "leave", subflowKey: "vacation-request", employeeHrId: "B-52", managerHrId: "A-99" });
  assert.equal(sim.found, true, "leave/vacation-request simulation resolves");
  assert.ok(sim.steps.some((s) => /manager/i.test(s.routesTo)), "simulator routes a step to the direct manager");
  assert.ok(sim.steps.some((s) => /hr final decision/i.test(s.name)), "simulator includes the HR final decision step");
  assert.ok(/approved|rejected/i.test(sim.finalStatus), "vacation simulation ends at HR approve/reject");

  // Warnings: missing manager and missing HR recipient.
  const missingManager = simulateWorkflow({ domainKey: "leave", subflowKey: "vacation-request", employeeHrId: "B-52" });
  assert.ok(missingManager.warnings.some((w) => /manager/i.test(w)), "simulator warns when the direct manager is missing");
  const missingHr = simulateWorkflow({ domainKey: "leave", subflowKey: "vacation-request", employeeHrId: "B-52", managerHrId: "A-99", hrSpecialistAvailable: false });
  assert.ok(missingHr.warnings.some((w) => /hr/i.test(w)), "simulator warns when no HR Specialist recipient is configured");

  // Default subflow + unknowns degrade safely.
  const defaultSubflow = simulateWorkflow({ domainKey: "payroll" });
  assert.equal(defaultSubflow.found, true, "domain simulation defaults to the first subflow");
  assert.equal(simulateWorkflow({ domainKey: "nope" }).found, false, "unknown domain is not found");
  assert.equal(simulateWorkflow({ domainKey: "leave", subflowKey: "nope" }).found, false, "unknown subflow is not found");

  // Routing copy fix: Expense submit must NOT be mislabeled "routes to Direct
  // manager" (it routes to approvers). Vacation submit DOES route to a manager.
  const expSim = simulateWorkflow({ domainKey: "expenses-outstation", subflowKey: "expense", employeeHrId: "B-52" });
  const expSubmit = expSim.steps.find((s) => s.id === "submit");
  assert.ok(expSubmit, "expense submit step simulated");
  assert.equal(/direct manager/i.test(expSubmit?.routesTo ?? ""), false, "expense submit is NOT mislabeled as routing to Direct manager");
  assert.match(expSubmit?.routesTo ?? "", /approver/i, "expense submit routes to approvers (business-friendly copy)");
  const vacSubmit = sim.steps.find((s) => s.id === "submit");
  assert.match(vacSubmit?.routesTo ?? "", /direct manager/i, "vacation submit correctly routes to the direct manager");

  // Phase 1.5 simulator output: route path, action-required recipients, and the
  // new warning classes (notification gap, read-only domain, runtime-edit lock).
  assert.equal(sim.routePath.length, sim.steps.length, "simulator returns a route path for every step");
  assert.ok(sim.routePath.some((r) => /manager/i.test(r)), "route path includes the manager hop");
  assert.ok((vacSubmit?.actionRequiredRecipients ?? []).some((r) => /manager/i.test(r)), "vacation submit action-required goes to the manager");
  assert.ok(sim.steps.some((s) => s.emailRecipients.length > 0), "simulator returns email recipients");
  assert.ok(sim.steps.some((s) => s.notificationRecipients.length > 0), "simulator returns in-app notification recipients");
  assert.ok(sim.warnings.some((w) => /runtime editing is disabled in phase 1/i.test(w)), "simulator warns runtime editing is disabled in Phase 1");

  const gapSim = simulateWorkflow({ domainKey: "expenses-outstation", subflowKey: "expense", employeeHrId: "B-52" });
  assert.ok(gapSim.warnings.some((w) => /no in-app notification producer/i.test(w)), "simulator warns about a missing notification producer");

  const readOnlySim = simulateWorkflow({ domainKey: "notifications", subflowKey: "recipient-resolver" });
  assert.ok(readOnlySim.warnings.some((w) => /read-only map only/i.test(w)), "simulator warns a cross-cutting domain is read-only map only");

  // ---------------------------------------------------------------------------
  // Phase-1 guarantee: read-only modules never call a mutation/DB path.
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

  // Phase 2 teaser content: draft/publish/rollback + runtime-safety reassurance.
  assert.match(centerSrc, /draft.*publish.*rollback/i, "Phase 2 teaser mentions draft/publish/rollback");
  assert.match(centerSrc, /not changed/i, "Phase 2 teaser states runtime execution is not changed in Phase 1");
  assert.match(centerSrc, /cannot accidentally change live workflow/i, "Phase 2 teaser reassures no accidental live changes");
  // Domain cards surface modules + notification/email coverage + gaps.
  assert.match(centerSrc, /domainNotificationCount|domainEmailCount/, "cards show notification/email coverage");
  assert.match(centerSrc, /modules/, "cards show modules-affected count");
  assert.match(centerSrc, /open gap/, "cards surface open gap counts");

  // Stale-result fix: the simulator panel is keyed by domain + subflow so it
  // remounts (and clears any previous result) whenever the selection changes.
  assert.match(centerSrc, /key=\{`sim-/, "simulator panel is keyed by domain + subflow");

  // Responsive / no desktop-only width.
  assert.match(centerSrc, /grid-cols-1[^"]*sm:grid-cols-2[^"]*lg:grid-cols-3/, "domain grid uses responsive columns");
  assert.match(centerSrc, /flex-wrap/, "subflow chips / badges wrap");
  assert.match(centerSrc, /lg:grid-cols-2/, "map + simulator stack to one column on small screens");
  assert.match(centerSrc, /max-w-6xl/, "center uses a responsive max width, not a fixed desktop width");
  assert.equal(/w-\[\d{3,}px\]/.test(centerSrc), false, "center has no fixed 3+ digit px width");

  const simPanelSrc = readFileSync(new URL("../src/components/workflow-control/workflow-simulator-panel.tsx", import.meta.url), "utf8");
  assert.match(simPanelSrc, /sm:grid-cols-2/, "simulator inputs use a responsive grid");
  assert.equal(/w-\[\d{3,}px\]/.test(simPanelSrc), false, "simulator panel has no fixed desktop-only width");

  const mapSrcResponsive = readFileSync(new URL("../src/components/workflow-control/workflow-map.tsx", import.meta.url), "utf8");
  assert.equal(/w-\[\d{3,}px\]/.test(mapSrcResponsive), false, "map has no fixed desktop-only width");

  const pageSrc = readFileSync(new URL("../app/admin/workflow-control/page.tsx", import.meta.url), "utf8");
  assert.match(pageSrc, /canAccessWorkflowControlCenter/, "page enforces the workflow-control access gate");
  assert.match(pageSrc, /redirect\("\/employee-portals"\)/, "page redirects unauthorized roles");
}
