import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { probationEndDate } from "../src/lib/probation/date.ts";
import { isProbationFieldRoleTitle, PROBATION_FIELD_ROLE_TITLES } from "../src/lib/probation/intelligence/cases.ts";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

export function runProbationCaseProvisioningTests() {
  const cases = source("src/lib/probation/intelligence/cases.ts");
  const backfill = source("src/lib/probation/intelligence/backfill.ts");

  // ── FIELD ROLES ONLY (owner, 13-14 Nov 2026, audit item REC-074) ──
  // "Field roles only", then "All sales managers": a Medical Representative or a District / Senior
  // District / Regional / National Sales Manager gets a probation case automatically; office and
  // head-office roles never do. It replaced the 2026-07-17 Medical-Representatives-only rule.
  const inScope = [
    "Medical Representative",
    "Senior Medical Representative",
    "  medical rep  ",
    "District Sales Manager",
    "Senior District Manager",
    "Regional Sales Manager",
    "National Sales Manager",
  ];
  for (const title of inScope) assert.equal(isProbationFieldRoleTitle(title), true, `${title.trim()} is a field role`);
  // Every office manager title live in production on 14 Nov 2026, plus the obvious non-titles.
  const outOfScope = [
    "Training Manager",
    "Product Manager",
    "Group Product Manager",
    "SFE Manager",
    "Marketing Manager",
    "HR Manager",
    "Finance and Admin Manager",
    "Toll Manufacturing Manager (TMM)",
    "Regulatory Affairs Supervisor",
    "Admin Assistant",
    "",
  ];
  for (const title of outOfScope) assert.equal(isProbationFieldRoleTitle(title), false, `${title || "an empty title"} is not a field role`);
  assert.equal(isProbationFieldRoleTitle(null), false, "a null title is out of scope");

  // The app-layer choke point (ensureProbationCase) enforces the scope with a skippedReason.
  assert.match(cases, /if \(!isProbationFieldRoleTitle\(identity\.jobTitle\)\)/, "ensureProbationCase guards on the field-role scope");
  assert.match(cases, /skippedReason: "not_field_role"/, "an office-role provisioning is surfaced, not created");
  // The backfill PLAN also excludes office roles so the dry-run report is accurate.
  assert.match(backfill, /if \(!isProbationFieldRoleTitle\(/, "backfill plan skips office roles");
  // The dashboard / tracker / Export PDF+Excel / manager portal all build from getProbationRows, which
  // lists the hire+90 WINDOW from the employee directory (NOT probation_cases). It needs its OWN guard,
  // the same one — else an office role in their window leaks onto the dashboard with Pass/Terminate/
  // Feedback actions (found in the 2026-07-17 live walkthrough: 15 shown -> 11).
  const service = source("src/lib/probation/service.ts");
  assert.match(service, /\.filter\(\(employee\) => isProbationFieldRoleTitle\(employee\.positionTitle \?\? employee\.jobTitle\)\)/,
    "getProbationRows (dashboard/tracker/exports/portal) is field-roles-only");
  // Employee 360's team view lists the same people as the tracker, managers on the team included.
  const teamLifecycle = source("src/lib/employee-360/team-lifecycle.ts");
  assert.match(teamLifecycle, /for \(const e of teamPeople\) \{\s*if \(!isProbationFieldRoleTitle\(/,
    "the team view's probation list uses the tracker's rule over reps AND managers");
  for (const file of [cases, backfill, service, teamLifecycle]) {
    assert.doesNotMatch(file, /isMedicalRepresentativeTitle/, "no surface keeps the retired Medical-Reps-only rule");
  }
  // The DB trigger (the primary hire path) carries the SAME list — an app guard alone would leak via the
  // AFTER INSERT / AFTER UPDATE triggers. This is the load-bearing enforcement for every hire path, so
  // the regex in the newest migration that recreates the function must hold exactly the app's list.
  const scopeTrigger = source("supabase/migrations/20261114021245_probation_covers_field_sales_managers.sql");
  assert.match(scopeTrigger, /create or replace function public\.probation_provision_case_on_hire/, "trigger function is recreated with the guard");
  const guard = /if lower\(coalesce\(new\.job_title, ''\)\) !~ '\(([^)]*)\)' then\s*return new;/.exec(scopeTrigger);
  assert.ok(guard, "the trigger guards on the field-role job-title regex");
  assert.deepEqual(guard![1].split("|"), [...PROBATION_FIELD_ROLE_TITLES], "the trigger's title list equals PROBATION_FIELD_ROLE_TITLES, in order");
  assert.doesNotMatch(scopeTrigger.split("$function$")[1] ?? "", /position\('medical rep'/, "the trigger no longer holds the Medical-Reps-only guard");

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
