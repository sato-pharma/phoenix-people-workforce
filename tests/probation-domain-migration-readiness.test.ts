import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Structural readiness checks for the Phase 1 domain migration + Phase 2 provisioning trigger.
// These guard the invariants the domain code depends on (single source of truth, dedup keys,
// idempotency, RLS posture, no-Extend, canonical date rule) without needing a live DB.

const DOMAIN = "supabase/migrations/20260713130000_probation_intelligence_domain.sql";
const TRIGGER = "supabase/migrations/20260713131000_probation_provision_trigger.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

export function runProbationDomainMigrationReadinessTests() {
  const sql = read(DOMAIN);

  // All eight domain tables + the history extension are present.
  for (const table of [
    "probation_cases",
    "probation_dv_days",
    "probation_dv_visits",
    "probation_feedback",
    "probation_feedback_versions",
    "probation_assessments",
    "probation_development_actions",
    "probation_config",
  ]) {
    assert.match(
      sql,
      new RegExp(`create table if not exists public\\.${table}\\b`, "i"),
      `${table} must be created (idempotently)`,
    );
  }

  // Purely additive + idempotent + transactional.
  assert.match(sql, /^\s*begin;/im, "migration must be wrapped in a transaction");
  assert.match(sql, /commit;\s*$/im, "migration must commit");
  assert.doesNotMatch(sql, /drop table|drop column|truncate\b/i, "migration must be non-destructive");
  assert.match(sql, /add column if not exists case_id/i, "probation_history.case_id added idempotently");

  // Single source of truth: one case per employee (hard dedup guard).
  assert.match(sql, /employee_hr_id text not null unique/i, "probation_cases enforces one case per employee");

  // One DV-Day per (evaluator, employee, date); a CRM activity can attach to only one DV-Day.
  assert.match(sql, /unique \(evaluator_hr_id, employee_hr_id, dv_date\)/i, "DV-Day dedup key required");
  assert.match(sql, /crm_visit_id bigint unique/i, "per-visit CRM id must be unique (no double-count)");

  // Exactly one active feedback per DV-Day.
  assert.match(sql, /dv_day_id uuid not null unique references public\.probation_feedback|dv_day_id uuid not null unique/i,
    "one active feedback per DV-Day");

  // Spec-mandated DV validation statuses are all present.
  for (const status of [
    "detected", "validation_pending", "validated", "feedback_pending",
    "feedback_completed", "rejected", "duplicate", "invalid", "manually_reviewed",
  ]) {
    assert.ok(sql.includes(`'${status}'`), `DV status ${status} must be defined`);
  }

  // No Extend anywhere in the decision domain (constraint-level, not comment text).
  assert.doesNotMatch(sql, /extension_end_date|probation_extended/i, "no extension column/status");
  assert.doesNotMatch(sql, /in \('pass','terminate','extend'\)|'extend'\s*\)/i, "extend must not be an allowed decision");
  assert.match(sql, /decision in \('pass','terminate'\)/i, "decision limited to pass/terminate");

  // Config singleton with the owner-locked defaults (1-10 scale, DM3/TM1/PM|GPM1/NSM1, SLA hours).
  assert.match(sql, /constraint probation_config_singleton check \(id\)/i, "config must be a singleton");
  assert.match(sql, /"dm":3[\s\S]*"tm":1[\s\S]*"pm_gpm":1[\s\S]*"nsm":1/, "default requirements 3/1/1/1");
  assert.match(sql, /"min":1,"max":10/i, "scoring scale 1-10");
  assert.match(sql, /dueHours":24[\s\S]*escalateHours":48[\s\S]*overdueHours":72/, "SLA default hours");

  // RLS enabled on every new table (service-role-only posture, no browser policies).
  const rlsCount = (sql.match(/enable row level security/gi) ?? []).length;
  assert.ok(rlsCount >= 8, `every new table must enable RLS (found ${rlsCount})`);

  // Phase 2 provisioning trigger readiness.
  const trigger = read(TRIGGER);
  assert.match(trigger, /after insert on public\.employees/i, "provision on AFTER INSERT of employees");
  assert.match(trigger, /on conflict \(employee_hr_id\) do nothing/i, "trigger insert idempotent");
  assert.match(trigger, /hire_date \+ interval '90 days'/i, "trigger uses canonical hire+90");
  assert.match(trigger, /exception when others then/i, "trigger never blocks a hire");
  assert.match(trigger, /probation_provisioning_failures/i, "failures recorded, not swallowed");
}
