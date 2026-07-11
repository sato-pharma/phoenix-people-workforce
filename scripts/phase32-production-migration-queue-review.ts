// RETIRED 2026-07-11: this script implemented a production-migration approval gate built
// around one specific pre-baseline migration, which is now archived under
// supabase/_migrations_archive/pre-baseline-2026-07-11/. That gate concept is superseded by
// the baseline-snapshot model — see docs/migrations.md ("Baseline Model") for the current
// approach. Left in place for history/reference; not part of the active migration pipeline.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import postgres from "postgres";

type Check = {
  details?: unknown;
  label: string;
  ok: boolean;
};

type MigrationHistoryRow = {
  version: string;
};

type RlsRow = {
  relrowsecurity: boolean;
  table_name: string;
};

type GrantRow = {
  grantee: string;
  privilege_type: string;
  table_name: string;
};

type PolicyRow = {
  cmd: string;
  policyname: string;
  roles: string[];
  tablename: string;
};

type FunctionPrivilegeRow = {
  anon_execute: boolean;
  authenticated_execute: boolean;
  function_name: string;
  public_execute: boolean;
};

const checks: Check[] = [];
const warnings: string[] = [];

const phase21Migration = "supabase/migrations/20260518232733_phase21_security_access_governance_hardening.sql";
const phase28Migration = "supabase/migrations/20260519102840_phase28_production_schema_parity_readiness.sql";
const phase21Version = "20260518232733";
const phase28Version = "20260519102840";

const hiringDocumentTables = [
  "hiring_document_definitions",
  "hiring_document_statuses",
  "hiring_document_employee_notes",
];

const triggerFunctions = [
  "phx_autofill_replacement_vacancy_from_employee_insert",
  "phx_enforce_terminal_employee_lifecycle_flags",
  "phx_release_terminal_manager_ownership_trigger",
];

loadLocalEnv();

function loadLocalEnv() {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // The runner may inject environment variables directly.
  }
}

function addCheck(label: string, ok: boolean, details?: unknown) {
  checks.push({ details, label, ok });
  if (!ok) throw new Error(`${label} failed${details ? `: ${JSON.stringify(details)}` : ""}`);
}

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the read-only Phase 32 queue review`);
  return value;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function fetchMigrationHistory(sql: postgres.Sql) {
  return await sql<MigrationHistoryRow[]>`
    select version::text
    from supabase_migrations.schema_migrations
    where version in (${phase21Version}, ${phase28Version})
    order by version
  `;
}

async function fetchRlsRows(sql: postgres.Sql) {
  return await sql<RlsRow[]>`
    select c.relname as table_name, c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in ${sql(hiringDocumentTables)}
    order by c.relname
  `;
}

async function fetchGrantRows(sql: postgres.Sql) {
  return await sql<GrantRow[]>`
    select table_name, grantee, privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ${sql(hiringDocumentTables)}
      and grantee in ('anon', 'authenticated', 'service_role')
    order by table_name, grantee, privilege_type
  `;
}

async function fetchPolicyRows(sql: postgres.Sql) {
  return await sql<PolicyRow[]>`
    select tablename, policyname, roles, cmd
    from pg_policies
    where schemaname = 'public'
      and tablename in ${sql(hiringDocumentTables)}
    order by tablename, policyname
  `;
}

async function fetchFunctionPrivileges(sql: postgres.Sql) {
  return await sql<FunctionPrivilegeRow[]>`
    select
      p.proname as function_name,
      has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ${sql(triggerFunctions)}
    order by p.proname
  `;
}

function verifyMigrationSource() {
  const phase21Sql = readFileSync(phase21Migration, "utf8");
  const phase28Sql = readFileSync(phase28Migration, "utf8");
  addCheck("Phase 21 migration is server-owned hiring-document hardening only", (
    /hiring_document_definitions/.test(phase21Sql) &&
    /hiring_document_statuses/.test(phase21Sql) &&
    /hiring_document_employee_notes/.test(phase21Sql) &&
    /revoke all on table public\.hiring_document_definitions from anon, authenticated/i.test(phase21Sql) &&
    /to service_role/i.test(phase21Sql)
  ), { sha256: sha256(phase21Sql) });
  addCheck("Phase 21 migration does not touch employees or payroll tables", (
    !/\b(employees|salary_batches|salary_records)\b/i.test(phase21Sql) &&
    !/\bdelete\s+from\b|\bupdate\s+public\./i.test(phase21Sql)
  ));
  addCheck("Phase 28 migration remains the schema parity migration", (
    /phase28_production_schema_parity_readiness/i.test(phase28Migration) &&
    /app_auth_users[\s\S]*session_version/i.test(phase28Sql)
  ), { sha256: sha256(phase28Sql) });
}

async function main() {
  verifyMigrationSource();

  const sql = postgres(requireEnv("SUPABASE_DB_URL"), {
    max: 1,
    prepare: false,
    ssl: "require",
  });

  try {
    const [historyRows, rlsRows, grantRows, policyRows, functionPrivileges] = await Promise.all([
      fetchMigrationHistory(sql),
      fetchRlsRows(sql),
      fetchGrantRows(sql),
      fetchPolicyRows(sql),
      fetchFunctionPrivileges(sql),
    ]);

    const appliedVersions = new Set(historyRows.map((row) => row.version));
    const rlsDisabled = rlsRows.filter((row) => !row.relrowsecurity);
    const directAppGrants = grantRows.filter((row) => row.grantee === "anon" || row.grantee === "authenticated");
    const serviceRolePolicies = policyRows.filter((row) => row.roles.includes("service_role"));
    const missingServiceRolePolicyTables = hiringDocumentTables.filter((table) =>
      !serviceRolePolicies.some((policy) => policy.tablename === table),
    );
    const exposedTriggerFunctions = functionPrivileges.filter((row) =>
      row.public_execute || row.anon_execute || row.authenticated_execute,
    );

    addCheck("migration history confirms Phase 21 and Phase 28 are not applied", (
      !appliedVersions.has(phase21Version) && !appliedVersions.has(phase28Version)
    ), historyRows);
    addCheck("Phase 21 hiring-document tables have RLS enabled in production", rlsDisabled.length === 0, {
      rlsRows,
      rlsDisabled,
    });
    addCheck("Phase 21 direct anon/authenticated grants are absent in production", directAppGrants.length === 0, {
      directAppGrants,
      grantRows,
    });
    addCheck("Phase 21 service-role policies are already present in production", missingServiceRolePolicyTables.length === 0, {
      missingServiceRolePolicyTables,
      policyRows,
    });
    addCheck("Phase 21 trigger functions are not executable by public/anon/authenticated", exposedTriggerFunctions.length === 0, {
      exposedTriggerFunctions,
      functionPrivileges,
    });

    const phase21PostureAlreadyReflected =
      rlsDisabled.length === 0 &&
      directAppGrants.length === 0 &&
      missingServiceRolePolicyTables.length === 0 &&
      exposedTriggerFunctions.length === 0;

    console.log(JSON.stringify({
      checks,
      migrationHistory: {
        appliedVersions: [...appliedVersions],
        phase21Applied: appliedVersions.has(phase21Version),
        phase28Applied: appliedVersions.has(phase28Version),
      },
      migrationQueueDecision: {
        decision: "NO_GO_FOR_APPLY_UNTIL_PHASE21_HISTORY_STRATEGY_IS_APPROVED",
        reason: "Supabase dry-run lists Phase 21 and Phase 28. Read-only posture shows Phase 21's intended production posture is already reflected, but migration history does not mark Phase 21 applied.",
        recommendedNextStep: "Approve a non-mutating migration-history reconciliation for Phase 21 only after backup/PITR confirmation, or explicitly approve applying Phase 21 and Phase 28 together.",
      },
      phase21Review: {
        functionPrivileges,
        grantRows,
        phase21PostureAlreadyReflected,
        policyRows,
        rlsRows,
      },
      phase28Status: {
        blockedUntilQueueClean: true,
        policyCleanupDeferred: true,
      },
      warnings,
    }, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: message(error), warnings }, null, 2));
  process.exitCode = 1;
});
