import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type Check = {
  details?: unknown;
  label: string;
  ok: boolean;
  status: "blocked" | "manual_required" | "passed" | "prepared";
};

const phase21Version = "20260518232733";
const phase21Migration = "supabase/migrations/20260518232733_phase21_security_access_governance_hardening.sql";
const phase32Script = "scripts/phase32-production-migration-queue-review.ts";
const checks: Check[] = [];

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function addCheck(label: string, ok: boolean, status: Check["status"], details?: unknown) {
  checks.push({ details, label, ok, status });
  if (!ok && status !== "manual_required" && status !== "blocked") {
    throw new Error(`${label} failed${details ? `: ${JSON.stringify(details)}` : ""}`);
  }
}

function main() {
  const phase21Sql = readFileSync(phase21Migration, "utf8");
  const phase32Source = readFileSync(phase32Script, "utf8");
  const phase21Checksum = sha256(phase21Sql);
  const phase32HasReadOnlyProof =
    /Phase 21 production posture is already reflected|phase21PostureAlreadyReflected/.test(phase32Source) &&
    /supabase_migrations\.schema_migrations/.test(phase32Source) &&
    /has_function_privilege/.test(phase32Source);
  const phase21SafeScope =
    /hiring_document_definitions/.test(phase21Sql) &&
    /hiring_document_statuses/.test(phase21Sql) &&
    /hiring_document_employee_notes/.test(phase21Sql) &&
    !/\bdelete\s+from\s+public\.(employees|salary_batches|salary_records)\b/i.test(phase21Sql) &&
    !/\bupdate\s+public\.(employees|salary_batches|salary_records)\b/i.test(phase21Sql);

  addCheck("Phase 21 migration file is selected", phase21Checksum === "e50dce046b3167a976d704099b6518f2cfcb46fc829c33d8710828a6a26482c0", "passed", {
    checksum: phase21Checksum,
    file: phase21Migration,
  });
  addCheck("Phase 21 scope is limited to hiring-document hardening", phase21SafeScope, "passed");
  addCheck("Phase 32 read-only proof package exists", phase32HasReadOnlyProof, "passed");
  addCheck("backup/PITR must be confirmed before migration-history reconciliation", false, "manual_required");
  addCheck("migration-history reconciliation command is prepared but blocked", false, "blocked");

  console.log(JSON.stringify({
    approvalGate: {
      status: "BLOCKED_UNTIL_EXPLICIT_APPROVAL",
      noMigrationHistoryWriteExecuted: true,
      noMigrationApplyExecuted: true,
      noDeploymentExecuted: true,
    },
    approvalChecklist: [
      "Confirm Phase 32 read-only posture check passes immediately before reconciliation.",
      "Confirm Supabase dry-run still lists Phase 21 and Phase 28 only.",
      "Confirm Phase 21 production posture is already reflected.",
      "Confirm Phase 21 is absent from supabase_migrations.schema_migrations.",
      "Confirm production backup/PITR window before any migration-history write.",
      "Run migration repair only after explicit approval.",
      "Run Supabase dry-run after repair and confirm only Phase 28 remains pending.",
    ],
    checks,
    exactSqlPreparedButNotRun: {
      cliPreferred: `npx supabase migration repair ${phase21Version} --status applied --db-url "$env:SUPABASE_DB_URL"`,
      sqlFallback: [
        "insert into supabase_migrations.schema_migrations (version, statements, name)",
        `values ('${phase21Version}', array[]::text[], 'phase21_security_access_governance_hardening')`,
        "on conflict (version) do nothing;",
      ].join("\n"),
    },
    recommendation: "PREPARED_NOT_APPROVED",
    reconciliationScope: {
      phase21Checksum,
      phase21Migration,
      targetVersion: phase21Version,
    },
  }, null, 2));
}

main();
