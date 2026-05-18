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
    /approveAcceptedOffer/,
    "Phase 15 smoke must use the existing accepted-offer approval service.",
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
  assert.match(
    phase15SmokeSource,
    /probation termination fixture skipped because schema\/RPC is not ready/,
    "Phase 15 smoke must report probation schema readiness as an explicit skipped gap.",
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
  assert.match(
    phase15SmokeSource,
    /v_active_organogram[\s\S]*v_payroll_eligible_employees/,
    "Phase 15 smoke must prove terminal employees leave effective organogram and payroll eligibility views.",
  );
}
