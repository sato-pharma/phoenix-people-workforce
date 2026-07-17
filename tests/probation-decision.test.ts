import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canDecideProbation } from "../src/lib/probation/intelligence/decision.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

export function runProbationDecisionTests() {
  // ── P10-T01 decision authority (owner-confirmed: CEO + Super Admin/HR + NSM) ──
  assert.equal(canDecideProbation({ role: "CEO", scope: "company" }), true, "CEO may decide");
  assert.equal(canDecideProbation({ role: "Super Admin", scope: "system" }), true, "Super Admin may decide");
  assert.equal(canDecideProbation({ role: "National Sales Manager", scope: "line" }), true, "NSM may decide");
  assert.equal(canDecideProbation({ role: "District Manager", scope: "team" }), false, "DM may NOT decide");
  assert.equal(canDecideProbation({ role: "Employee", scope: "self" }), false, "Employee may NOT decide");
  assert.equal(canDecideProbation({ role: "SFE Manager", scope: "company" }), false, "SFE Manager may NOT decide");

  const svc = src("src/lib/probation/intelligence/decision.ts");

  // Pass / Terminate only — "extend" is not an accepted outcome value.
  assert.match(svc, /outcome !== "pass" && input\.outcome !== "terminate"/, "only pass/terminate accepted");
  assert.doesNotMatch(svc, /"extend"|'extend'|probation_extended/i, "no extend outcome value in the decision service");

  // Validation gates.
  assert.match(svc, /a decision comment is required/i, "comment required");
  assert.match(svc, /acknowledge you have reviewed the consolidated evidence/i, "evidence ack required");
  assert.match(svc, /not decision-ready; an override reason is required/i, "override reason required when not ready");

  // No double-decide.
  assert.match(svc, /already been decided/i, "rejects a second decision");
  assert.match(svc, /\.is\("decision", null\)/, "decision write guarded to the first writer");

  // NSM scope check (company-wide roles bypass; NSM must be in the chain).
  assert.match(svc, /this probation case is outside your scope/i, "NSM scope enforced");

  // Side effects EXACTLY ONCE via the side_effects_applied_at claim.
  assert.match(svc, /\.is\("side_effects_applied_at", null\)/, "side-effect slot claimed atomically");
  assert.match(svc, /if \(!claimed\) return false/, "already-applied side effects are a no-op");
  // Pass activation + terminate resignation.
  assert.match(svc, /employment_status: "active", organogram_visible: true, payroll_eligible: true/, "pass activates the employee");
  assert.match(svc, /resignEmployeeAndOpenVacancy\(/, "terminate opens resignation/vacancy");

  // Durable audit + decision snapshot.
  assert.match(svc, /writeRequiredAuditLog\(/, "durable audit on decision");
  assert.match(svc, /entityType: "probation_decision"/, "audited as probation_decision");
  assert.match(svc, /buildConsolidatedReport\(access, caseId\)/, "captures a decision-time snapshot");

  // ── P10-T04 Extend teardown ──
  const migration = src("supabase/migrations/20260713135000_probation_decision_snapshot_and_extend_teardown.sql");
  assert.match(migration, /probation_extended/i, "migration references the dead status to remove it");
  assert.match(migration, /decision_snapshot jsonb/i, "decision_snapshot column added");

  // ── Post-decision lock wired into feedback + assessments ──
  const cases = src("src/lib/probation/intelligence/cases.ts");
  assert.match(cases, /already been decided and is locked/i, "lock helper defined");
  const feedback = src("src/lib/probation/intelligence/feedback-workflow.ts");
  assert.match(feedback, /assertCaseAcceptsSubmissions\(/, "feedback submit respects the post-decision lock");
  const assessments = src("src/lib/probation/intelligence/assessments.ts");
  assert.match(assessments, /assertCaseAcceptsSubmissions\(/, "assessment submit respects the post-decision lock");

  // Route: CSRF + coarse gate.
  const route = src("app/api/probation/cases/[caseId]/decision/route.ts");
  assert.match(route, /assertSameOriginMutation/, "decision route CSRF-guarded");
  assert.match(route, /decideProbation\(/, "route delegates to the decision service");
}
