import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const phase15SmokeSource = readFileSync("scripts/phase15-disposable-fixture-smoke.ts", "utf8");
const phase15LoaderSource = readFileSync("scripts/phase15-tsx-email-stub-loader.mjs", "utf8");
const resignationServiceSource = readFileSync("src/lib/resignations/service.ts", "utf8");
const auditSource = readFileSync("src/lib/admin/audit.ts", "utf8");

export function runPhase15DisposableFixtureSmokeTests() {
  assert.match(
    phase15SmokeSource,
    /const fixture = `PHASE15_\$\{suffix\}`\.toUpperCase\(\)/,
    "Phase 15 smoke fixtures must be clearly PHASE15-prefixed.",
  );
  assert.match(
    phase15SmokeSource,
    /finally\s*\{\s*await cleanup\(\);/,
    "Phase 15 smoke must always attempt cleanup in a finally block.",
  );
  assert.match(
    phase15SmokeSource,
    /resignEmployeeAndOpenVacancy/,
    "Phase 15 smoke must use the existing resignation lifecycle service.",
  );
  assert.match(
    phase15SmokeSource,
    /updateSalesBatchStatus/,
    "Phase 15 smoke must use the existing sales import workflow service.",
  );
  assert.match(
    phase15SmokeSource,
    /createSalaryBatch[\s\S]*replaceSalaryBatch[\s\S]*runPayrollWorkflow/,
    "Phase 15 smoke must use the existing payroll upload/replace/workflow services.",
  );
  assert.match(
    phase15SmokeSource,
    /importApprovedExpensesToPayroll/,
    "Phase 15 smoke must use the existing approved-expense import service.",
  );
  // REC-010 (14 Nov 2026): the legacy probation evaluation workflow was retired; a probation is
  // decided on its case, so this smoke no longer drives a probation termination.
  assert.doesNotMatch(
    phase15SmokeSource,
    /runProbationWorkflow/,
    "Phase 15 smoke must not call the retired probation evaluation workflow.",
  );
  assert.match(
    phase15LoaderSource,
    /src\/emails/,
    "Phase 15 Node smoke must stub TSX email templates instead of sending email from fixture runs.",
  );
  assert.match(
    auditSource,
    /"employee_resignation"/,
    "Global audit entity types must include employee_resignation.",
  );
  assert.match(
    resignationServiceSource,
    /writeRequiredAuditLog/,
    "Resignation and termination lifecycle mutations must persist a required shared audit trace.",
  );
  assert.match(
    resignationServiceSource,
    /entityType:\s*"employee_resignation"/,
    "Resignation and termination audit traces must use the employee_resignation entity type.",
  );
  assert.match(
    resignationServiceSource,
    /organogram_visible:\s*false[\s\S]*payroll_eligible:\s*false/,
    "Resignation and termination must remove employees from organogram and payroll eligibility.",
  );
  // The ratchet forbids READING the dropped view, not naming it: the comment that explains why it
  // is gone has to be allowed to say its name.
  assert.doesNotMatch(
    phase15SmokeSource,
    /from\("v_active_organogram"\)/,
    "Phase 15 smoke must not read v_active_organogram — it was dropped on 2026-10-12 and the EU organogram (au_v_*) is the source of truth.",
  );
  assert.match(
    phase15SmokeSource,
    /v_payroll_eligible_employees[\s\S]*organogram_visible === false/,
    "Phase 15 smoke must still prove terminal employees lose the organogram flag and leave payroll eligibility.",
  );
}
