import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  canAccessWorkflowControlCenter,
  canEditWorkflowControlCenter,
  WORKFLOW_CONTROL_EDIT_ENABLED,
} from "../src/lib/auth/permissions.ts";
import {
  getWorkflowDomain,
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

  // Every step across every subflow exposes notification + email recipient fields.
  for (const domain of domains) {
    assert.ok(domain.subflows.length > 0, `${domain.key} has subflows`);
    for (const subflow of domain.subflows) {
      for (const step of subflow.steps) {
        assert.ok(Array.isArray(step.notificationRecipients), `${domain.key}/${subflow.key}/${step.id} has notificationRecipients`);
        assert.ok(Array.isArray(step.emailRecipients), `${domain.key}/${subflow.key}/${step.id} has emailRecipients`);
      }
    }
  }

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

  const pageSrc = readFileSync(new URL("../app/admin/workflow-control/page.tsx", import.meta.url), "utf8");
  assert.match(pageSrc, /canAccessWorkflowControlCenter/, "page enforces the workflow-control access gate");
  assert.match(pageSrc, /redirect\("\/employee-portals"\)/, "page redirects unauthorized roles");
}
