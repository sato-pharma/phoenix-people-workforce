import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(p: string) { return readFileSync(p, "utf8"); }

// Regression guard for the LEGACY→NEW probation desync bug.
//
// Two probation systems coexist. The legacy workflow (runProbationWorkflow → applyDecisionSideEffects)
// resigns/passes an employee but historically never updated the newer `probation_cases` table that
// the CEO Probation Decision Dashboard AND the milestone-email sweep read. A legacy-decided employee
// therefore showed as a permanently "active" case: kept getting milestone emails and kept accepting
// feedback. These assertions pin the write-through mirror that closes the desync.
export function runProbationLegacyWritesToCasesTests() {
  const service = src("src/lib/probation/service.ts");

  // The mirror helper exists and reuses the ready-made case lookup (no second lookup implementation).
  assert.match(
    service,
    /async function mirrorLegacyDecisionToProbationCase\(record: ProbationWorkflowRecord\)/,
    "service defines mirrorLegacyDecisionToProbationCase(record)",
  );
  assert.match(
    service,
    /getProbationCaseByEmployee\(record\.employeeHrId\)/,
    "mirror reuses getProbationCaseByEmployee for the case lookup",
  );

  // Writes into probation_cases with the correct decided shape.
  assert.match(service, /\.from\("probation_cases"\)/, "mirror updates probation_cases");
  assert.match(service, /status: "decided"/, "mirror flips the case status to decided");
  assert.match(
    service,
    /side_effects_applied_at: now/,
    "mirror stamps side_effects_applied_at so the new module does not re-drive side effects",
  );

  // Idempotency / never-overwrite guards: only the first writer records the decision.
  assert.match(service, /\.is\("decision", null\)/, 'mirror update is guarded by .is("decision", null)');
  assert.match(
    service,
    /if \(probationCase\.decision \|\| probationCase\.status !== "active"\) return;/,
    "mirror never overwrites a case already decided elsewhere",
  );

  // The mirror is actually invoked from applyDecisionSideEffects, so it runs for pass AND terminate.
  assert.match(
    service,
    /async function applyDecisionSideEffects\(record: ProbationWorkflowRecord\)[\s\S]*?await mirrorLegacyDecisionToProbationCase\(record\);/,
    "applyDecisionSideEffects calls the legacy→cases mirror",
  );

  // Best-effort: a mirror failure is recorded to the monitoring sink, never thrown into the decision.
  assert.match(
    service,
    /probation_provisioning_failures[\s\S]*?legacy_decision_writethrough/,
    "mirror failures are recorded to probation_provisioning_failures (best-effort, non-blocking)",
  );
}
