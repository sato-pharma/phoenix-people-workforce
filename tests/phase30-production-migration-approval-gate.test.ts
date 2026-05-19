import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase30ProductionMigrationApprovalGateTests() {
  const gate = readFileSync("scripts/phase30-production-migration-approval-gate.ts", "utf8");

  assert.match(gate, /BLOCKED_UNTIL_EXPLICIT_APPROVAL/);
  assert.match(gate, /expectedChecksum = "e001a0d5c530262056f803ea656a529320a71e49a38ba71af063ee02fabb95ce"/);
  assert.match(gate, /production backup\/PITR readiness must be confirmed/);
  assert.match(gate, /DEFER_TO_SEPARATE_MIGRATION/);
  assert.match(gate, /npx supabase db push --db-url/);
  assert.match(gate, /--dry-run/);
  assert.match(gate, /--yes/);
  assert.match(gate, /Do not run apply unless the dry-run output shows only 20260519102840_phase28_production_schema_parity_readiness\.sql/);
  assert.match(gate, /noProductionMutationExecuted: true/);
  assert.match(gate, /noDeploymentExecuted: true/);
  assert.match(gate, /no employee data rewrite is present/);
  assert.match(gate, /no payroll fixture deletion is present/);
  assert.match(gate, /no payroll lock weakening is present/);
  assert.match(gate, /service-route guarded RLS posture is preserved/);

  assert.doesNotMatch(gate, /exec|spawn|execFile/);
  assert.doesNotMatch(gate, /postgres\(/);
  assert.doesNotMatch(gate, /createClient/);
  assert.doesNotMatch(gate, /\bdelete\s+from\b/i);
  assert.doesNotMatch(gate, /\bupdate\s+public\.(employees|salary_batches|salary_records)\b/i);
  assert.doesNotMatch(gate, /vercel\s+(--prod|deploy)/i);
}
