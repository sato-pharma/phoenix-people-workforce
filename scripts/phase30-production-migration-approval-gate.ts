import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type GateCheck = {
  details?: unknown;
  label: string;
  ok: boolean;
  status: "blocked" | "manual_required" | "passed" | "prepared";
};

const migrationFile = "supabase/migrations/20260519102840_phase28_production_schema_parity_readiness.sql";
const expectedChecksum = "e001a0d5c530262056f803ea656a529320a71e49a38ba71af063ee02fabb95ce";
const migrationSql = readFileSync(migrationFile, "utf8");
const checks: GateCheck[] = [];

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function addCheck(
  label: string,
  ok: boolean,
  status: GateCheck["status"],
  details?: unknown,
) {
  checks.push({ details, label, ok, status });
  if (!ok && status !== "manual_required" && status !== "blocked") {
    throw new Error(`${label} failed${details ? `: ${JSON.stringify(details)}` : ""}`);
  }
}

function main() {
  const actualChecksum = sha256(migrationSql);
  const exactMigrationMatches = actualChecksum === expectedChecksum;
  const noEmployeeRewrite = !/\bupdate\s+public\.employees\b/i.test(migrationSql);
  const noPayrollDeletion = !/\bdelete\s+from\s+public\.(salary_batches|salary_records)\b/i.test(migrationSql);
  const noEmployeeDeletion = !/\bdelete\s+from\s+public\.employees\b/i.test(migrationSql);
  const noPayrollUnlock = !/locked_at\s*=\s*null|part1_paid_at\s*=\s*null|status\s*=\s*'uploaded'/i.test(migrationSql);
  const serviceRouteGuarded =
    /revoke all on table public\.employee_probation from anon, authenticated/i.test(migrationSql) &&
    /revoke all on table public\.v2_vacation_requests from anon, authenticated/i.test(migrationSql) &&
    /to service_role/i.test(migrationSql) &&
    !/\bto\s+authenticated\b/i.test(migrationSql);

  addCheck("exact Phase 28 migration file checksum is confirmed", exactMigrationMatches, "passed", {
    actualChecksum,
    expectedChecksum,
    migrationFile,
  });
  addCheck("no employee data rewrite is present", noEmployeeRewrite, "passed");
  addCheck("no payroll fixture deletion is present", noPayrollDeletion, "passed");
  addCheck("no employee deletion is present", noEmployeeDeletion, "passed");
  addCheck("no payroll lock weakening is present", noPayrollUnlock, "passed");
  addCheck("service-route guarded RLS posture is preserved", serviceRouteGuarded, "passed");
  addCheck(
    "production backup/PITR readiness must be confirmed by the owner immediately before apply",
    false,
    "manual_required",
  );
  addCheck(
    "employee_probation authenticated policy cleanup is deferred to a separate migration unless explicitly approved",
    true,
    "prepared",
  );
  addCheck("production apply command is prepared but blocked until explicit approval", false, "blocked");

  console.log(JSON.stringify({
    applyGate: {
      status: "BLOCKED_UNTIL_EXPLICIT_APPROVAL",
      noProductionMutationExecuted: true,
      noDeploymentExecuted: true,
    },
    backupPitRChecklist: [
      "Confirm Supabase project is the Phoenix production project before apply.",
      "Confirm a recent backup or PITR recovery window is available immediately before apply.",
      "Run the Phase 28 read-only smoke immediately before apply.",
      "Run the Supabase dry-run command and confirm it lists only the Phase 28 migration.",
      "Apply only after explicit approval in this thread.",
    ],
    checks,
    exactMigration: {
      checksum: actualChecksum,
      file: migrationFile,
      lineCount: migrationSql.split(/\r?\n/g).length,
    },
    policyCleanupDecision: {
      decision: "DEFER_TO_SEPARATE_MIGRATION",
      reason: "The schema parity migration is additive. Dropping existing employee_probation authenticated policies is a separate policy-risk decision.",
    },
    preparedCommands: {
      dryRun: "npx supabase db push --db-url \"$env:SUPABASE_DB_URL\" --dry-run",
      applyBlocked: "npx supabase db push --db-url \"$env:SUPABASE_DB_URL\" --yes",
      applyCondition: "Do not run apply unless the dry-run output shows only 20260519102840_phase28_production_schema_parity_readiness.sql and the user explicitly approves.",
    },
    recommendation: "READY_FOR_EXPLICIT_APPROVAL_AFTER_BACKUP_AND_DRY_RUN_CONFIRMATION",
  }, null, 2));
}

main();
