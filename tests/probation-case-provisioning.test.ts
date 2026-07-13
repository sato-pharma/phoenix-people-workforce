import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { probationEndDate } from "../src/lib/probation/date.ts";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

export function runProbationCaseProvisioningTests() {
  const cases = source("src/lib/probation/intelligence/cases.ts");
  const backfill = source("src/lib/probation/intelligence/backfill.ts");

  // ensureProbationCase is the single idempotent entry point.
  assert.match(cases, /export async function ensureProbationCase/, "ensureProbationCase must be exported");

  // Idempotency: it MUST look up an existing case before inserting, and return it unchanged.
  assert.match(
    cases,
    /getProbationCaseByEmployee\([\s\S]*?if \(existing\) return \{ case: existing, created: false \}/,
    "must return the existing case without overwriting (idempotent)",
  );

  // Concurrency safety: a unique violation is treated as already-exists, not a hard error.
  assert.match(cases, /isUniqueViolation/, "must handle a create race via unique-violation detection");
  assert.match(cases, /23505/, "unique-violation detection keys off the Postgres 23505 code");

  // Dedup guard: end date derives from the canonical hire+90 helper, never a local formula.
  assert.match(cases, /probationEndDate\(/, "case end date must use the canonical hire+90 helper");
  assert.doesNotMatch(cases, /addMonths|\+\s*3\b/, "no legacy +3-month math in provisioning");

  // Missing hire date is surfaced (skippedReason), never fabricated.
  assert.match(cases, /skippedReason: "missing_hire_date"/, "missing hire date must be surfaced, not invented");

  // Backfill: dry-run is the default and writes nothing.
  assert.match(backfill, /const dryRun = options\.dryRun \?\? true/, "backfill must default to dry-run");
  assert.match(backfill, /if \(dryRun\) return plan/, "dry-run must return the plan without writing");

  // Backfill is rerunnable/idempotent — it writes through ensureProbationCase, not a raw insert.
  assert.match(backfill, /ensureProbationCase\(/, "backfill must write via the idempotent ensureProbationCase");

  // Unresolved records are surfaced with a reason, never silently dropped.
  assert.match(backfill, /unresolved\.push\(\{[\s\S]*?reason:/, "unresolved employees must be surfaced with a reason");

  // Only in-window, active employees are eligible.
  assert.match(backfill, /isWithinProbationWindow\(/, "eligibility gated on the 90-day window");
  assert.match(backfill, /INACTIVE_STATUSES/, "terminated/resigned/inactive excluded");

  // Single guaranteed hook: an AFTER INSERT trigger on employees provisions every hire path.
  const trigger = source("supabase/migrations/20260713131000_probation_provision_trigger.sql");
  assert.match(trigger, /after insert on public\.employees/i, "must provision via an AFTER INSERT trigger on employees");
  assert.match(trigger, /on conflict \(employee_hr_id\) do nothing/i, "trigger insert must be idempotent");
  assert.match(trigger, /hire_date \+ interval '90 days'/i, "trigger uses the canonical hire+90 rule");
  assert.match(trigger, /in \('terminated', 'resigned', 'inactive'\)/i, "trigger skips already-exited employees");
  // Non-blocking + monitored: failures are recorded, never allowed to break a hire.
  assert.match(trigger, /exception when others then/i, "trigger must be exception-guarded (never blocks a hire)");
  assert.match(trigger, /probation_provisioning_failures/i, "provisioning failures must be recorded, not swallowed");

  // Sanity: canonical date helper still behaves (guards against accidental regressions here).
  assert.equal(probationEndDate("2026-05-02"), "2026-07-31", "hire+90 sanity check");
}
