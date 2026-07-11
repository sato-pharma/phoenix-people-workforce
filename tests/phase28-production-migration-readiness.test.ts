import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase28ProductionMigrationReadinessTests() {
  const smoke = readFileSync("scripts/phase28-production-migration-readiness-smoke.ts", "utf8");
  const migration = readFileSync(
    "supabase/_migrations_archive/pre-baseline-2026-07-11/20260519102840_phase28_production_schema_parity_readiness.sql",
    "utf8",
  );

  assert.match(smoke, /SUPABASE_DB_URL/);
  assert.match(smoke, /information_schema\.columns/);
  assert.match(smoke, /pg_policies/);
  assert.match(smoke, /information_schema\.role_table_grants/);
  assert.match(smoke, /salary_batches/);
  assert.match(smoke, /salary_records/);
  assert.match(smoke, /noProductionMutationsExecuted/);
  assert.match(smoke, /migration SQL covers every discovered schema parity gap/);
  assert.match(smoke, /production grants keep probation\/vacation service-route owned/);
  assert.match(smoke, /migration SQL does not add direct authenticated probation\/vacation policies/);
  assert.doesNotMatch(smoke, /await\s+sql(?:<[^>]+>)?`\s*(insert|update|delete|alter|create|drop|grant|revoke|notify)\b/i);

  assert.match(migration, /alter table if exists public\.app_auth_users[\s\S]*session_version integer not null default 1/i);
  assert.match(migration, /alter table if exists public\.employees[\s\S]*has_bank_account text/i);
  assert.match(migration, /alter table if exists public\.employees[\s\S]*department_id bigint/i);
  assert.match(migration, /alter table if exists public\.employees[\s\S]*payroll_eligible boolean default true/i);
  assert.match(migration, /alter table if exists public\.areas[\s\S]*line_id bigint null references public\.lines\(id\)/i);
  assert.match(migration, /alter table public\.teams[\s\S]*area_id bigint null references public\.areas\(id\)/i);
  assert.match(migration, /alter table public\.teams[\s\S]*is_active boolean not null default true/i);
  assert.match(migration, /create table if not exists public\.employee_probation/i);
  assert.match(migration, /create table if not exists public\.probation_evaluations/i);
  assert.match(migration, /create table if not exists public\.probation_history/i);
  assert.match(migration, /create table if not exists public\.v2_vacation_requests/i);
  assert.match(migration, /create table if not exists public\.v2_vacation_request_events/i);
  assert.match(migration, /create table if not exists public\.v2_vacation_email_tokens/i);
  assert.match(migration, /alter table public\.v2_vacation_requests enable row level security/i);
  assert.match(migration, /revoke all on table public\.v2_vacation_requests from anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.v2_vacation_requests to service_role/i);
  assert.match(migration, /create policy v2_vacation_requests_service_role_all/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);

  assert.doesNotMatch(migration, /\bdrop\s+/i);
  assert.doesNotMatch(migration, /\btruncate\s+/i);
  assert.doesNotMatch(migration, /\bdelete\s+from\s+public\.(employees|salary_batches|salary_records)\b/i);
  assert.doesNotMatch(migration, /\bupdate\s+public\.(employees|salary_batches|salary_records)\b/i);
  assert.doesNotMatch(migration, /locked_at\s*=\s*null/i);
  assert.doesNotMatch(migration, /part1_paid_at\s*=\s*null/i);
  assert.doesNotMatch(migration, /status\s*=\s*'uploaded'/i);
  assert.doesNotMatch(migration, /to authenticated/i);
  assert.doesNotMatch(migration, /phase25|phase26/i);
}
