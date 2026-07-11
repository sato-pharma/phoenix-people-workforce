import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase29ProductionMigrationPreapplyReviewTests() {
  const script = readFileSync("scripts/phase29-production-migration-preapply-review.ts", "utf8");
  const migration = readFileSync(
    "supabase/_migrations_archive/pre-baseline-2026-07-11/20260519102840_phase28_production_schema_parity_readiness.sql",
    "utf8",
  );

  assert.match(script, /phase28_production_schema_parity_readiness\.sql/);
  assert.match(script, /expectedProductionGaps/);
  assert.match(script, /employee_probation\.manager_hr_id/);
  assert.match(script, /v2_vacation_requests\.working_days/);
  assert.match(script, /READY_FOR_APPROVAL_GATE_ONLY_NOT_APPLIED/);
  assert.match(script, /preApplyChecklist/);
  assert.match(script, /blocked_until_approved/);
  assert.match(script, /policyCleanupRecommendation/);
  assert.match(script, /separate explicit policy-cleanup migration/);
  assert.match(script, /Confirm no employee data rewrite/);
  assert.match(script, /Confirm no payroll fixture deletion/);
  assert.match(script, /Confirm no payroll lock weakening/);
  assert.match(script, /Confirm RLS\/grants remain service-route guarded/);

  assert.doesNotMatch(script, /postgres\(/);
  assert.doesNotMatch(script, /createClient/);
  assert.doesNotMatch(script, /supabase\s+db\s+(push|reset|migrate)/i);
  assert.doesNotMatch(script, /vercel\s+(--prod|deploy)/i);
  assert.doesNotMatch(script, /\bdelete\s+from\b/i);
  assert.doesNotMatch(script, /\bupdate\s+public\.(employees|salary_batches|salary_records)\b/i);

  assert.match(migration, /add column if not exists manager_hr_id text null/i);
  assert.match(migration, /add column if not exists notes text null/i);
  assert.match(migration, /add column if not exists working_days numeric not null default 1/i);
  assert.match(migration, /add column if not exists calendar_days numeric not null default 1/i);
  assert.match(migration, /add column if not exists decision text null/i);
  assert.match(migration, /add column if not exists note text null/i);
  assert.match(migration, /revoke all on table public\.employee_probation from anon, authenticated/i);
  assert.match(migration, /revoke all on table public\.v2_vacation_requests from anon, authenticated/i);
  assert.doesNotMatch(migration, /\bdrop\s+/i);
  assert.doesNotMatch(migration, /\btruncate\s+/i);
  assert.doesNotMatch(migration, /\bdelete\s+from\s+public\.(employees|salary_batches|salary_records)\b/i);
  assert.doesNotMatch(migration, /\bupdate\s+public\.(employees|salary_batches|salary_records)\b/i);
  assert.doesNotMatch(migration, /\bto\s+authenticated\b/i);
}
