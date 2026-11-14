import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migrationSource = readFileSync("supabase/_migrations_archive/pre-baseline-2026-07-11/20260518203241_phase16_production_schema_gap_burndown.sql", "utf8");
const terminalRpcMigrationSource = readFileSync("supabase/_migrations_archive/pre-baseline-2026-07-11/20260518204301_phase16_terminal_flag_rpc_repair.sql", "utf8");
const terminalRestoreDropSource = readFileSync("supabase/_migrations_archive/pre-baseline-2026-07-11/20260518204724_phase16_drop_terminal_visibility_restore.sql", "utf8");
const outstationServiceSource = readFileSync("src/lib/outstation/service.ts", "utf8");
const auditSource = readFileSync("src/lib/admin/audit.ts", "utf8");
const phase16SmokeSource = readFileSync("scripts/phase16-disposable-fixture-smoke.ts", "utf8");
const resignationServiceSource = readFileSync("src/lib/resignations/service.ts", "utf8");

export function runPhase16ProductionGapBurndownTests() {
  assert.match(
    migrationSource,
    /create table if not exists public\.probation_evaluations/i,
    "Phase 16 migration must make probation evaluations schema-ready.",
  );
  assert.match(
    migrationSource,
    /create table if not exists public\.probation_history/i,
    "Phase 16 migration must make probation history schema-ready.",
  );
  assert.match(
    migrationSource,
    /alter table public\.employee_probation add column if not exists employee_hr_id/i,
    "Phase 16 migration must reconcile legacy probation HR_ID columns.",
  );
  assert.match(
    migrationSource,
    /phx_enforce_terminal_employee_lifecycle_flags/,
    "Terminal employee lifecycle raw flags must be enforced in the database.",
  );
  assert.match(
    migrationSource,
    /before insert or update of employment_status, payroll_eligible, organogram_visible/i,
    "Terminal employee lifecycle enforcement must run before employees are persisted.",
  );
  assert.match(
    migrationSource,
    /payroll_eligible = false[\s\S]*organogram_visible = false/i,
    "Existing terminal employees must be normalized out of raw payroll and organogram flags.",
  );
  assert.match(
    terminalRpcMigrationSource,
    /phx_normalize_terminal_employee_lifecycle_flags/,
    "Terminal raw flag normalization must be available as a service-callable RPC.",
  );
  assert.match(
    resignationServiceSource,
    /normalizeTerminalEmployeeLifecycleFlags/,
    "Resignation and termination paths must call terminal raw flag normalization after lifecycle mutation.",
  );
  assert.match(
    resignationServiceSource,
    /phx_normalize_terminal_employee_lifecycle_flags/,
    "Resignation and termination paths must prefer the shared terminal raw flag RPC.",
  );
  assert.match(
    terminalRestoreDropSource,
    /drop trigger if exists phx_restore_terminal_employee_visibility/i,
    "Legacy terminal visibility restore trigger must be removed because it conflicts with raw terminal flags.",
  );

  assert.match(
    outstationServiceSource,
    /approveOutstationRequestForPayroll/,
    "Outstation approval-to-payroll readiness must be a reusable service mutation.",
  );
  assert.match(
    outstationServiceSource,
    /savePayrollExpenseApprovals/,
    "Outstation approval must create payroll expense rows through the shared payroll expense source.",
  );
  assert.match(
    outstationServiceSource,
    /writeRequiredAuditLog/,
    "Outstation approval must persist a required shared audit trace.",
  );
  assert.match(
    outstationServiceSource,
    /entityType:\s*"outstation_request"/,
    "Outstation approval audit traces must use the outstation_request entity type.",
  );
  assert.match(
    auditSource,
    /"outstation_request"/,
    "Global audit entity types must include outstation_request.",
  );

  assert.match(
    phase16SmokeSource,
    /const fixture = `PHASE16_\$\{suffix\}`\.toUpperCase\(\)/,
    "Phase 16 smoke fixtures must be clearly PHASE16-prefixed.",
  );
  assert.match(
    phase16SmokeSource,
    /finally\s*\{\s*await cleanup\(\);/,
    "Phase 16 smoke must always attempt cleanup in a finally block.",
  );
  // REC-010 (14 Nov 2026): the legacy probation evaluation workflow was retired; a probation is
  // decided on its case (/api/probation/cases/[caseId]/decision), so the smoke no longer drives it.
  assert.doesNotMatch(
    phase16SmokeSource,
    /createProbationEvaluation|runProbationWorkflow/,
    "Phase 16 smoke must not call the retired probation evaluation workflow.",
  );
  assert.match(
    phase16SmokeSource,
    /createVacationRequest[\s\S]*decideVacationRequest/,
    "Phase 16 smoke must test vacation approval through the app service workflow.",
  );
  assert.match(
    phase16SmokeSource,
    /approveOutstationRequestForPayroll/,
    "Phase 16 smoke must test outstation approval-to-payroll readiness.",
  );
  assert.doesNotMatch(
    phase16SmokeSource,
    /locked_at:\s*null|status:\s*"uploaded"[\s\S]*salary_batches/,
    "Phase 16 cleanup must not bypass payroll lock rules by resetting salary_batches.",
  );
}
