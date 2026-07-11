import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase32ProductionMigrationQueueReviewTests() {
  const script = readFileSync("scripts/phase32-production-migration-queue-review.ts", "utf8");
  const phase21 = readFileSync(
    "supabase/_migrations_archive/pre-baseline-2026-07-11/20260518232733_phase21_security_access_governance_hardening.sql",
    "utf8",
  );

  assert.match(script, /SUPABASE_DB_URL/);
  assert.match(script, /supabase_migrations\.schema_migrations/);
  assert.match(script, /20260518232733/);
  assert.match(script, /20260519102840/);
  assert.match(script, /information_schema\.role_table_grants/);
  assert.match(script, /pg_policies/);
  assert.match(script, /has_function_privilege/);
  assert.match(script, /NO_GO_FOR_APPLY_UNTIL_PHASE21_HISTORY_STRATEGY_IS_APPROVED/);
  assert.match(script, /phase21PostureAlreadyReflected/);
  assert.match(script, /blockedUntilQueueClean: true/);
  assert.match(script, /policyCleanupDeferred: true/);
  assert.doesNotMatch(script, /await\s+sql(?:<[^>]+>)?`\s*(insert|update|delete|alter|create|drop|grant|revoke|notify)\b/i);
  assert.doesNotMatch(script, /supabase\s+db\s+(push|reset|migrate)/i);
  assert.doesNotMatch(script, /vercel\s+(--prod|deploy)/i);

  assert.match(phase21, /revoke all on table public\.hiring_document_definitions from anon, authenticated/i);
  assert.match(phase21, /revoke all on table public\.hiring_document_statuses from anon, authenticated/i);
  assert.match(phase21, /revoke all on table public\.hiring_document_employee_notes from anon, authenticated/i);
  assert.match(phase21, /to service_role/i);
  assert.match(phase21, /revoke execute on function public\.phx_autofill_replacement_vacancy_from_employee_insert\(\)/i);
  assert.doesNotMatch(phase21, /\bdelete\s+from\s+public\.(employees|salary_batches|salary_records)\b/i);
  assert.doesNotMatch(phase21, /\bupdate\s+public\.(employees|salary_batches|salary_records)\b/i);
}
