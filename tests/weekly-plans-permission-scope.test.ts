import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  EMPLOYEE_PLAN_TRANSITIONS,
  type EmployeePlanAction,
  type EmployeePlanStatus,
} from "../src/lib/weekly-planning/plan-v1.ts";

function source(relPath: string) {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");
}

/**
 * Permission-scope invariants for Weekly Plans (PR 2 of the 10/10 plan).
 *
 * The domain service functions are not exported, so the tests are
 * source-text invariants that pin:
 *   - `canViewPlan` gates for DSM (manager match), CEO (unconditional), HR (hr_acknowledged)
 *   - `assertManagerReviewer` checks the manager's employment status (active guard)
 *   - Employee-active guards at submit + revise paths
 *   - `notifyManager` returns a `NotificationDeliveryStatus` and has Super Admin fallback
 *   - State machine completeness: every EmployeePlanAction that requires a role has a check
 *
 * Pattern mirrors tests/weekly-plans-rpc-contract.test.ts and
 * tests/position-vacancy-status-integrity.test.ts.
 */
export function runWeeklyPlansPermissionScopeTests() {
  const svc = source("src/lib/weekly-planning/service.ts");

  // ── canViewPlan: CEO unconditional access ─────────────────────────────────
  assert.match(
    svc,
    /function canViewPlan[\s\S]{0,500}access\.role === "CEO"/,
    "canViewPlan must grant unconditional access to the CEO role",
  );

  // ── canViewPlan: Super Admin unconditional access ─────────────────────────
  assert.match(
    svc,
    /function canViewPlan[\s\S]{0,600}access\.role === "Super Admin"/,
    "canViewPlan must grant unconditional access to Super Admin",
  );

  // ── canViewPlan: manager match (direct manager gate) ──────────────────────
  // The plan's literal direct manager always sees it via hrIdsMatch — separate from
  // the skip-level chain-visibility branch tested below.
  assert.match(
    svc,
    /function canViewPlan[\s\S]{0,600}hrIdsMatch\(access\.hrId, plan\.manager_hr_id\)/,
    "canViewPlan must gate non-admin access on hrIdsMatch(access.hrId, plan.manager_hr_id)",
  );

  // ── canViewPlan: HR reviewer limited to final-stage plans ─────────────────
  assert.match(
    svc,
    /isHrReviewer\(access, employee\)[\s\S]{0,200}\["final_approved", "hr_acknowledged"\]/,
    "canViewPlan must restrict HR reviewers to final-stage plans only",
  );

  // ── canViewPlan: skip-level manager-chain visibility ──────────────────────
  // A manager's manager (or deeper) must also see the plan, via the viewer's
  // precomputed downward chain (see src/lib/weekly-planning/plan-visibility.ts) —
  // not just the literal direct manager checked above. Real case: a Marketing
  // Manager must see a Product Manager's plan two levels down.
  assert.match(
    svc,
    /function canViewPlan[\s\S]{0,900}isPlanOwnerWithinViewerManagementChain\(plan\.employee_hr_id, scope\)/,
    "canViewPlan must also grant access when the plan owner is within the viewer's management chain",
  );

  // ── assertManagerReviewer: active-employment guard ────────────────────────
  assert.match(
    svc,
    /async function assertManagerReviewer[\s\S]{0,600}isActiveEmployee\(managerEmployee\)/,
    "assertManagerReviewer must verify the manager's employment status via isActiveEmployee()",
  );

  assert.match(
    svc,
    /assertManagerReviewer[\s\S]{0,700}only an active direct manager/,
    "assertManagerReviewer must throw a descriptive error for inactive managers",
  );

  // ── employee-active guard: submit path ────────────────────────────────────
  assert.match(
    svc,
    /isActiveEmployee\(employee\)[\s\S]{0,200}only active employees can submit/,
    "createEmployeePlan must guard against inactive employees submitting plans",
  );

  // ── employee-active guard: revise path ───────────────────────────────────
  assert.match(
    svc,
    /isActiveEmployee\(owner\)[\s\S]{0,200}only active employees can revise/,
    "updateEmployeePlan (revise) must guard against inactive employees revising plans",
  );

  // ── notifyManager: hardened with fallback chain ──────────────────────────
  assert.match(
    svc,
    /async function notifyManager[\s\S]{0,2000}NotificationDeliveryStatus/,
    "notifyManager must return NotificationDeliveryStatus",
  );

  assert.match(
    svc,
    /async function notifyManager[\s\S]{0,3000}resolveSuperAdminRecipients/,
    "notifyManager must have a Super Admin fallback via resolveSuperAdminRecipients()",
  );

  assert.match(
    svc,
    /async function notifyManager[\s\S]{0,2000}skip-level manager/,
    "notifyManager must attempt a skip-level manager fallback before Super Admin",
  );

  // ── notifyHrOnSubmit: Super Admin fallback for symmetry ──────────────────
  assert.match(
    svc,
    /async function notifyHrOnSubmit[\s\S]{0,2000}resolveSuperAdminRecipients/,
    "notifyHrOnSubmit must fall back to Super Admin when hrAcknowledgementRecipients() yields 0",
  );

  // ── State machine completeness: manager_ actions gated by assertManagerReviewer
  const allActions = Object.keys(EMPLOYEE_PLAN_TRANSITIONS) as EmployeePlanAction[];
  const managerActions = allActions.filter((a) => a.startsWith("manager_"));
  assert.ok(
    managerActions.length > 0,
    "expected at least one manager_ action in EMPLOYEE_PLAN_TRANSITIONS",
  );
  assert.match(
    svc,
    /input\.action\.startsWith\("manager_"\)[\s\S]{0,600}assertManagerReviewer/,
    "decideEmployeePlan must gate all manager_ actions with assertManagerReviewer",
  );

  // ── assertManagerReviewer is awaited (async) ─────────────────────────────
  assert.match(
    svc,
    /await assertManagerReviewer\(access, plan\)/,
    "assertManagerReviewer must be awaited in decideEmployeePlan (it is async since PR 2)",
  );

  // ── CEO actions gated by assertCeoReviewer + weekly_plans:approve ─────────
  assert.match(
    svc,
    /input\.action\.startsWith\("ceo_"\)[\s\S]{0,300}assertPermission[\s\S]{0,200}weekly_plans.*approve/,
    "decideEmployeePlan must gate CEO actions with assertPermission(weekly_plans, approve)",
  );

  // ── ceo_ actions then assertCeoReviewer ──────────────────────────────────
  assert.match(
    svc,
    /assertCeoReviewer\(access\)/,
    "assertCeoReviewer must be called on CEO actions",
  );

  // ── reassignWeeklyPlanManager: HR/Super-Admin re-routes a stuck plan (never decides it) ──
  assert.match(
    svc,
    /export async function reassignWeeklyPlanManager/,
    "service must export reassignWeeklyPlanManager",
  );
  // Two-part auth gate: the standing weekly_plans:approve grant AND Super-Admin (isHrReviewer).
  assert.match(
    svc,
    /reassignWeeklyPlanManager[\s\S]{0,600}assertPermission\(access, "weekly_plans", "approve"\)/,
    "reassignWeeklyPlanManager must require the weekly_plans:approve permission",
  );
  assert.match(
    svc,
    /reassignWeeklyPlanManager[\s\S]{0,800}isHrReviewer\(access, null\)/,
    "reassignWeeklyPlanManager must additionally require Super Admin via isHrReviewer",
  );
  // Status guard: only the reassignable set (mirrors D4).
  assert.match(
    svc,
    /REASSIGNABLE_PLAN_STATUSES[\s\S]{0,140}"submitted"[\s\S]{0,60}"manager_returned"[\s\S]{0,60}"ceo_returned"/,
    "reassignable set must be submitted/manager_returned/ceo_returned (mirrors the D4 detector)",
  );
  assert.match(
    svc,
    /reassignWeeklyPlanManager[\s\S]{0,1000}REASSIGNABLE_PLAN_STATUSES\.includes\(plan\.status\)/,
    "reassignWeeklyPlanManager must guard plan.status against the reassignable set",
  );
  // New manager must be resolved against the directory and be active.
  assert.match(
    svc,
    /reassignWeeklyPlanManager[\s\S]{0,1500}isActiveEmployee\(newManager\)/,
    "reassignWeeklyPlanManager must reject an inactive new manager",
  );
  // Direct column update — NOT a decision RPC (reassignment is never deciding-in-place).
  assert.match(
    svc,
    /reassignWeeklyPlanManager[\s\S]{0,1900}\.from\("employee_plan_headers"\)\s*\.update\(/,
    "reassignWeeklyPlanManager must update employee_plan_headers directly",
  );
  assert.doesNotMatch(
    svc,
    /reassignWeeklyPlanManager[\s\S]{0,2000}rpcDecidePlan\(/,
    "reassignWeeklyPlanManager must NOT call rpcDecidePlan() (reassignment is never deciding-in-place)",
  );
  assert.match(
    svc,
    /reassignWeeklyPlanManager[\s\S]{0,2100}writeAuditLog/,
    "reassignWeeklyPlanManager must write an audit-log entry with the old→new manager",
  );

  // ── drift SQL exists ───────────────────────────────────────────────────────
  const drift = source("scripts/weekly-plans-drift.sql");
  assert.match(drift, /D1:/, "drift SQL must include detector D1");
  assert.match(drift, /D2:/, "drift SQL must include detector D2");
  assert.match(drift, /D3:/, "drift SQL must include detector D3");
  assert.match(drift, /D4:/, "drift SQL must include detector D4");
  assert.match(drift, /D5:/, "drift SQL must include detector D5");
  assert.match(drift, /D6:/, "drift SQL must include detector D6");

  const driftStatuses: EmployeePlanStatus[] = [
    "final_approved",
    "submitted",
    "hr_acknowledged",
  ];
  for (const status of driftStatuses) {
    assert.match(
      drift,
      new RegExp(status.replace(/_/g, "[_]")),
      `drift SQL must reference status '${status}'`,
    );
  }
}
