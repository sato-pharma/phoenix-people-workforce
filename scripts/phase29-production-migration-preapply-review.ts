// RETIRED 2026-07-11: this script implemented a production-migration approval gate built
// around one specific pre-baseline migration, which is now archived under
// supabase/_migrations_archive/pre-baseline-2026-07-11/. That gate concept is superseded by
// the baseline-snapshot model — see docs/migrations.md ("Baseline Model") for the current
// approach. Left in place for history/reference; not part of the active migration pipeline.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

type Check = {
  details?: unknown;
  label: string;
  ok: boolean;
};

const migrationFile = "supabase/migrations/20260519102840_phase28_production_schema_parity_readiness.sql";
const migrationSql = readFileSync(migrationFile, "utf8");
const checks: Check[] = [];

const expectedProductionGaps = [
  "employee_probation.manager_hr_id",
  "employee_probation.notes",
  "v2_vacation_email_tokens.decision",
  "v2_vacation_request_events.note",
  "v2_vacation_requests.working_days",
  "v2_vacation_requests.calendar_days",
  "v2_vacation_requests.notes",
];

const expectedCoverage: Array<{ column: string; table: string }> = expectedProductionGaps.map((gap) => {
  const [table, column] = gap.split(".");
  return { column, table };
});

function addCheck(label: string, ok: boolean, details?: unknown) {
  checks.push({ details, label, ok });
  if (!ok) throw new Error(`${label} failed${details ? `: ${JSON.stringify(details)}` : ""}`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function migrationCovers(table: string, column: string) {
  const tablePattern = escapeRegExp(table);
  const columnPattern = escapeRegExp(column);
  const alterPattern = new RegExp(
    `alter\\s+table(?:\\s+if\\s+exists)?\\s+public\\.${tablePattern}[\\s\\S]*?add\\s+column\\s+if\\s+not\\s+exists\\s+${columnPattern}\\b`,
    "i",
  );
  const createPattern = new RegExp(
    `create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${tablePattern}\\s*\\([\\s\\S]*?\\b${columnPattern}\\b`,
    "i",
  );
  return alterPattern.test(migrationSql) || createPattern.test(migrationSql);
}

function countMatches(pattern: RegExp) {
  return [...migrationSql.matchAll(pattern)].length;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function latestPhase28Migration() {
  return readdirSync("supabase/migrations")
    .filter((name) => /phase28_production_schema_parity_readiness\.sql$/.test(name))
    .sort()
    .at(-1);
}

function main() {
  const latest = latestPhase28Migration();
  const uncovered = expectedCoverage.filter(({ table, column }) => !migrationCovers(table, column));

  addCheck("exact Phase 28 production migration SQL file is selected", migrationFile.endsWith(latest ?? ""), {
    latest,
    migrationFile,
  });
  addCheck("all seven Phase 28 production schema gaps are covered", uncovered.length === 0, {
    expectedProductionGaps,
    uncovered,
  });
  addCheck("migration is additive and idempotent", countMatches(/\bif\s+not\s+exists\b/gi) >= 20, {
    ifNotExistsCount: countMatches(/\bif\s+not\s+exists\b/gi),
  });
  addCheck("migration does not rewrite employee data", !/\bupdate\s+public\.employees\b/i.test(migrationSql));
  addCheck(
    "migration does not delete payroll fixtures or employee rows",
    !/\bdelete\s+from\s+public\.(employees|salary_batches|salary_records)\b/i.test(migrationSql),
  );
  addCheck(
    "migration does not weaken payroll locks",
    !/locked_at\s*=\s*null|part1_paid_at\s*=\s*null|status\s*=\s*'uploaded'/i.test(migrationSql),
  );
  addCheck(
    "probation and vacation production posture remains service-route guarded",
    /revoke all on table public\.employee_probation from anon, authenticated/i.test(migrationSql) &&
      /revoke all on table public\.v2_vacation_requests from anon, authenticated/i.test(migrationSql) &&
      /to service_role/i.test(migrationSql) &&
      !/\bto\s+authenticated\b/i.test(migrationSql),
  );
  addCheck("migration does not contain destructive DDL", !/\b(drop|truncate)\b/i.test(migrationSql));
  addCheck("migration is not an apply/deploy command", !/supabase\s+db\s+(push|reset|migrate)|vercel\s+(--prod|deploy)/i.test(migrationSql));

  console.log(JSON.stringify({
    checks,
    dryRunReview: {
      exactMigrationFile: migrationFile,
      migrationSha256: sha256(migrationSql),
      migrationLineCount: migrationSql.split(/\r?\n/g).length,
      productionSchemaGapsCovered: expectedProductionGaps,
      result: "READY_FOR_APPROVAL_GATE_ONLY_NOT_APPLIED",
    },
    policyCleanupRecommendation: {
      recommendation: "Keep Phase 28 schema parity migration additive. Review existing employee_probation authenticated policies as a separate explicit policy-cleanup migration only if the approval gate confirms they are no longer needed.",
      reason: "Dropping policies is a different risk class from adding missing schema columns and should not be mixed into this schema parity apply.",
    },
    preApplyChecklist: [
      { item: "Confirm production backup/PITR window before any future apply", status: "required_before_apply" },
      { item: "Confirm exact migration file and checksum", status: "ready", value: sha256(migrationSql) },
      { item: "Run Phase 28 read-only smoke immediately before apply", status: "required_before_apply" },
      { item: "Confirm no employee data rewrite", status: "passed" },
      { item: "Confirm no payroll fixture deletion", status: "passed" },
      { item: "Confirm no payroll lock weakening", status: "passed" },
      { item: "Confirm RLS/grants remain service-route guarded", status: "passed" },
      { item: "Approve or defer separate employee_probation policy cleanup", status: "manual_approval_required" },
      { item: "Apply only after explicit user approval", status: "blocked_until_approved" },
    ],
    rollbackPlan: {
      beforeApply: "Disable or edit the migration before applying if review finds a problem.",
      afterApply: "Leave additive columns/tables in place and revert app usage if needed; destructive rollback is intentionally not provided.",
    },
  }, null, 2));
}

main();
