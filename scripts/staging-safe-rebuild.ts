import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import postgres from "postgres";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "staging-safe-rebuild",
  entry: import.meta.url,
  known: ["--archive-current-staging", "--backup-current-staging", "--dry-run-new-staging", "--apply-new-staging", "--post-apply-verify-new", "--verify-new-staging"],
});

type TargetKind = "current" | "new";

type DbTarget = {
  databaseHost: string;
  databaseUrl: string;
  environment: string;
  refHint: string;
  supabaseHost: string;
  supabaseUrl: string;
};

type CliResult = {
  command: string;
  ok: boolean;
  output: string;
};

const localEnvPath = ".env.staging.rls.local";
const outputRoot = path.join("supabase-export", "staging-rebuild");
// 2026-07-11: staging moved to a new Pro-org project (cifwmndunmlxjhyjugxa) after this ref's
// free-tier project hit its storage quota and went read-only during a full production clone.
//
// 2026-09-04: that old project is now GONE from the Supabase account — `list_projects` does not
// return it, and AGENTS.md section 3 lists it among the dead refs. The comment that used to sit
// here said this constant "still resolves to a real project", and tests/staging-safe-rebuild.test.ts
// pinned the claim, so the falsehood got DEFENDED rather than looked up. It is kept, renamed, for
// the one thing it can still do honestly: refuse.
//
// "current" mode was built to export THIS project before rebuilding staging elsewhere, and it
// cannot be exported because it does not exist. So that mode now stops with a message saying so,
// instead of the opaque "target is not the known current staging project" it produced for every
// possible value of the environment. Nothing is lost — the mode could not succeed either way.
//
// It is deliberately NOT re-pointed at live staging. This file runs `db dump`, archive and apply
// paths; a historical rebuild tool must not acquire a live target as a side effect of a comment
// fix. If staging is ever rebuilt again, re-point it deliberately, in its own change.
const retiredStagingRef = "izhmxvgiktiafqusolot";
const productionRef = "ozucdzovmcqvepbozvqf";
const executiveMigrationVersion = "20260602082351";
const oldStagingArchiveConfirmName = "PHOENIX_CONFIRM_OLD_STAGING_ARCHIVE_ONLINE";
const oldStagingArchiveConfirmValue = "YES_OLD_STAGING_REMAINS_ONLINE";

const ceoSourceTableNames = [
  "employees",
  "position_vacancies",
  "salary_batches",
  "salary_records",
  "salary_flags",
  "sales_records",
  "payroll_expenses",
  "payroll_expense_reports",
  "job_offers",
];

const executiveRpcNames = [
  "phx_exec_workforce_snapshot",
  "phx_exec_vacancies_snapshot",
  "phx_exec_payroll_snapshot",
  "phx_exec_sales_snapshot",
  "phx_exec_expenses_snapshot",
  "phx_exec_contracts_snapshot",
  "phx_exec_probation_snapshot",
  "phx_exec_recruitment_snapshot",
  "phx_exec_leave_snapshot",
  "phx_exec_attendance_snapshot",
  "phx_exec_operations_snapshot",
];

function unquoteEnvValue(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadLocalEnvFile() {
  if (!existsSync(localEnvPath)) return { loadedKeys: 0, path: localEnvPath, status: "not_found" as const };
  const source = readFileSync(localEnvPath, "utf8");
  let loadedKeys = 0;
  for (const rawLine of source.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1));
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    process.env[key] = value;
    loadedKeys += 1;
  }
  return { loadedKeys, path: localEnvPath, status: "found" as const };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalEnv(name: string) {
  return process.env[name]?.trim() || "";
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function redactSecrets(value: string) {
  return value
    .replace(/postgresql:\/\/[^@\s]+@/gi, "postgresql://<redacted>@")
    .replace(/postgres:\/\/[^@\s]+@/gi, "postgres://<redacted>@")
    .replace(/(PHOENIX_[A-Z0-9_]*(?:KEY|URL|PASSWORD)=)[^\s]+/g, "$1<redacted>");
}

function truncateOutput(value: string, maxLength = 30000) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n... truncated ...` : value;
}

function withPoolerSafetyParams(rawUrl: string) {
  const url = new URL(rawUrl);
  url.searchParams.set("sslmode", "require");
  url.searchParams.set("default_query_exec_mode", "simple_protocol");
  url.searchParams.set("statement_cache_capacity", "0");
  url.searchParams.set("connect_timeout", "10");
  url.searchParams.set("options", "-c statement_timeout=8000");
  return url.toString();
}

function envPrefix(kind: TargetKind) {
  return kind === "current" ? "PHOENIX_STAGING" : "PHOENIX_NEW_STAGING";
}

function assertTarget(kind: TargetKind): DbTarget {
  const prefix = envPrefix(kind);
  const confirmName = kind === "current"
    ? "PHOENIX_CONFIRM_STAGING_RLS_RUN"
    : "PHOENIX_CONFIRM_NEW_STAGING_TARGET";
  const expectedConfirm = kind === "current" ? "YES_STAGING_ONLY" : "YES_NEW_STAGING_ONLY";
  const confirm = requiredEnv(confirmName);
  if (confirm !== expectedConfirm) {
    throw new Error(`${confirmName} must be exactly ${expectedConfirm}.`);
  }

  const environment = requiredEnv(`${prefix}_ENVIRONMENT`).toLowerCase();
  if (!/(staging|stage|preview|dev|test|branch|local)/.test(environment) || environment.includes("production")) {
    throw new Error(`Refusing ${kind} target because environment "${environment}" is not clearly non-production.`);
  }

  const supabaseUrl = requiredEnv(`${prefix}_SUPABASE_URL`).replace(/\/+$/g, "");
  const supabaseHost = new URL(supabaseUrl).hostname.toLowerCase();
  const rawDatabaseUrl = requiredEnv(`${prefix}_DATABASE_URL`);
  const databaseHost = new URL(rawDatabaseUrl).hostname.toLowerCase();
  const databaseUrl = withPoolerSafetyParams(rawDatabaseUrl);

  if (
    supabaseUrl.includes(productionRef) ||
    rawDatabaseUrl.includes(productionRef) ||
    supabaseHost.includes(productionRef) ||
    databaseHost.includes(productionRef)
  ) {
    throw new Error(`Refusing ${kind} target because it matches the Phoenix production Supabase ref.`);
  }

  if (kind === "current") {
    throw new Error(
      `Refusing "current" mode: the project it was built to export (${retiredStagingRef}) no longer ` +
        "exists on the Supabase account — see AGENTS.md section 3. Staging moved to " +
        "cifwmndunmlxjhyjugxa on 2026-07-11 and this historical rebuild tool was never re-pointed. " +
        "Re-point it deliberately if staging is ever rebuilt again; a rebuild tool must not acquire " +
        "a live target by accident.",
    );
  }

  if (supabaseHost.includes(retiredStagingRef) || rawDatabaseUrl.includes(retiredStagingRef)) {
    throw new Error("Refusing new staging target because it points to the retired staging archive project.");
  }

  return {
    databaseHost,
    databaseUrl,
    environment,
    refHint: supabaseHost.split(".")[0] ?? "unknown",
    supabaseHost,
    supabaseUrl,
  };
}

function createSql(target: DbTarget) {
  return postgres(target.databaseUrl, {
    max: 1,
    prepare: false,
    ssl: "require",
  });
}

function localMigrations() {
  return readdirSync("supabase/migrations")
    .map((fileName) => {
      const match = fileName.match(/^(\d{14})_(.+)\.sql$/);
      return match ? { fileName, version: match[1] } : null;
    })
    .filter((migration): migration is { fileName: string; version: string } => Boolean(migration))
    .sort((a, b) => a.version.localeCompare(b.version));
}

function supabaseExecutable() {
  return process.platform === "win32"
    ? path.resolve("node_modules", "supabase", "bin", "supabase.exe")
    : path.resolve("node_modules", ".bin", "supabase");
}

function createTempSupabaseProject() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "phoenix-staging-rebuild-"));
  mkdirSync(path.join(tempRoot, "supabase", "migrations"), { recursive: true });
  cpSync(path.join("supabase", "config.toml"), path.join(tempRoot, "supabase", "config.toml"));
  cpSync(path.join("supabase", "migrations"), path.join(tempRoot, "supabase", "migrations"), { recursive: true });
  return tempRoot;
}

function runSupabaseCli(args: string[], cwd: string): CliResult {
  const command = `supabase ${args.map((arg) => arg.startsWith("postgres") ? "<db-url-redacted>" : arg).join(" ")}`;
  try {
    const output = execFileSync(supabaseExecutable(), args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
    return { command, ok: true, output: truncateOutput(redactSecrets(output)) };
  } catch (error) {
    const caught = error as { message?: string; stderr?: Buffer | string; stdout?: Buffer | string };
    const output = truncateOutput(redactSecrets(`${caught.stdout?.toString() ?? ""}${caught.stderr?.toString() ?? ""}${caught.message ? `\n${caught.message}` : ""}`.trim()));
    return { command, ok: false, output };
  }
}

function runSupabaseCliInTemp(args: string[]) {
  const tempRoot = createTempSupabaseProject();
  try {
    return runSupabaseCli(args, tempRoot);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function gitStatus() {
  try {
    return redactSecrets(execFileSync("git", ["status", "--short", "--branch"], { encoding: "utf8" }));
  } catch (error) {
    return `git status unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function writeJson(filePath: string, value: unknown) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function safeArchiveSection<T>(name: string, load: () => Promise<T>) {
  try {
    return {
      name,
      ok: true as const,
      value: await load(),
    };
  } catch (error) {
    return {
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
      name,
      ok: false as const,
      value: null,
    };
  }
}

function assertOldStagingArchiveConfirmation() {
  const confirm = requiredEnv(oldStagingArchiveConfirmName);
  if (confirm !== oldStagingArchiveConfirmValue) {
    throw new Error(`${oldStagingArchiveConfirmName} must be exactly ${oldStagingArchiveConfirmValue}.`);
  }
}

async function collectRowCounts(sql: postgres.Sql) {
  const rows = await sql<Array<{ estimated_rows: string; schema: string; table: string }>>`
    select
      n.nspname as schema,
      c.relname as table,
      greatest(c.reltuples, 0)::bigint::text as estimated_rows
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'auth', 'storage', 'supabase_migrations')
      and c.relkind in ('r', 'p')
    order by n.nspname, c.relname
  `;
  return rows.map((row) => ({
    estimatedRows: Number(row.estimated_rows),
    note: "Estimated from PostgreSQL catalog statistics to avoid long count(*) scans during backup.",
    schema: row.schema,
    table: row.table,
  }));
}

async function collectMigrationHistory(sql: postgres.Sql) {
  const rows = await sql<Array<{ row: unknown }>>`
    select to_jsonb(m) as row
    from supabase_migrations.schema_migrations m
    order by version
  `;
  return rows.map((row) => row.row);
}

async function collectAuthMetadata(sql: postgres.Sql) {
  const userSummary = await sql<Array<{
    confirmed_users: string;
    total_users: string;
    users_with_last_sign_in: string;
  }>>`
    select
      count(*)::text as total_users,
      count(*) filter (where email_confirmed_at is not null)::text as confirmed_users,
      count(*) filter (where last_sign_in_at is not null)::text as users_with_last_sign_in
    from auth.users
  `;
  const identityProviders = await sql<Array<{ identities: string; provider: string }>>`
    select provider, count(*)::text as identities
    from auth.identities
    group by provider
    order by provider
  `;
  const appRoleCounts = await sql<Array<{ role: string; users: string }>>`
    select coalesce(role, 'unknown') as role, count(*)::text as users
    from public.app_auth_users
    group by coalesce(role, 'unknown')
    order by coalesce(role, 'unknown')
  `;
  return {
    appRoleCounts,
    identityProviders,
    note: "This metadata export intentionally uses summaries only. Sensitive auth password hashes, tokens, and full identity rows are not exported unless a separate sensitive auth dump is explicitly approved.",
    userSummary: userSummary[0] ?? null,
  };
}

async function collectStorageMetadata(sql: postgres.Sql) {
  const buckets = await sql<Array<{ row: unknown }>>`
    select to_jsonb(bucket) as row
    from storage.buckets bucket
    order by id
  `;
  const objectEstimate = await sql<Array<{ estimated_objects: string }>>`
    select greatest(c.reltuples, 0)::bigint::text as estimated_objects
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage'
      and c.relname = 'objects'
  `;
  return {
    buckets: buckets.map((row) => row.row),
    note: "This exports storage database metadata only. Supabase database backups do not include binary Storage object contents; keep old staging online until object files are separately copied or confirmed disposable.",
    objectEstimate: Number(objectEstimate[0]?.estimated_objects ?? 0),
  };
}

async function collectSelectedTableInventories(sql: postgres.Sql) {
  const tables = await sql<Array<{
    estimated_rows: string;
    is_ceo_source: boolean;
    schema: string;
    table: string;
  }>>`
    select
      n.nspname as schema,
      c.relname as table,
      greatest(c.reltuples, 0)::bigint::text as estimated_rows,
      c.relname = any(${ceoSourceTableNames}::text[]) as is_ceo_source
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
    order by is_ceo_source desc, n.nspname, c.relname
  `;

  const columns = await sql<Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    schema: string;
    table: string;
  }>>`
    select
      table_schema as schema,
      table_name as table,
      column_name,
      data_type,
      is_nullable
    from information_schema.columns
    where table_schema = 'public'
    order by table_schema, table_name, ordinal_position
  `;

  const columnMap = new Map<string, Array<{ columnName: string; dataType: string; isNullable: boolean }>>();
  for (const column of columns) {
    const key = `${column.schema}.${column.table}`;
    const current = columnMap.get(key) ?? [];
    current.push({
      columnName: column.column_name,
      dataType: column.data_type,
      isNullable: column.is_nullable === "YES",
    });
    columnMap.set(key, current);
  }

  return {
    note: "Inventory only. No business rows, payroll rows, salary rows, auth secrets, or employee PII are exported by archive-preserved mode.",
    tables: tables.map((table) => ({
      columns: columnMap.get(`${table.schema}.${table.table}`) ?? [],
      estimatedRows: Number(table.estimated_rows),
      isCeoSource: table.is_ceo_source,
      schema: table.schema,
      table: table.table,
    })),
  };
}

async function createArchivePreservedManifest() {
  assertOldStagingArchiveConfirmation();
  const target = assertTarget("current");
  const sql = createSql(target);
  const archiveId = `archive-preserved-${nowStamp()}`;
  const archiveDir = path.join(outputRoot, archiveId);
  mkdirSync(archiveDir, { recursive: true });

  try {
    await sql`select 1`;
    const rowCounts = await safeArchiveSection("row-counts", () => collectRowCounts(sql));
    const migrationHistory = await safeArchiveSection("migration-history", () => collectMigrationHistory(sql));
    const authMetadata = await safeArchiveSection("auth-metadata", () => collectAuthMetadata(sql));
    const storageMetadata = await safeArchiveSection("storage-metadata", () => collectStorageMetadata(sql));
    const selectedTableInventories = await safeArchiveSection("selected-table-inventories", () => collectSelectedTableInventories(sql));

    writeJson(path.join(archiveDir, "row-counts.json"), rowCounts);
    writeJson(path.join(archiveDir, "migration-history.json"), migrationHistory);
    writeJson(path.join(archiveDir, "auth-metadata.json"), authMetadata);
    writeJson(path.join(archiveDir, "storage-metadata.json"), storageMetadata);
    writeJson(path.join(archiveDir, "selected-table-inventories.json"), selectedTableInventories);

    const archiveSections = [
      rowCounts,
      migrationHistory,
      authMetadata,
      storageMetadata,
      selectedTableInventories,
    ];

    const manifest = {
      archiveDir,
      archiveId,
      archivePreserved: true,
      backupComplete: false,
      backupKind: "archive-preserved",
      createdAt: new Date().toISOString(),
      gitStatus: gitStatus(),
      localMigrationCount: localMigrations().length,
      notes: [
        "Current staging was read only. No reset, repair, delete, data import, or migration apply was executed.",
        "Old staging is the no-data-loss archive and must remain online until explicit deletion approval after the new staging target is validated.",
        "Archive-preserved mode intentionally avoids full Supabase CLI dumps because full old-staging dumps previously hung.",
        "No business rows, payroll rows, salary rows, auth secrets, or employee PII are exported by this mode.",
        "Storage binary object contents are not included. Keep old staging online until object files are separately copied or confirmed disposable.",
      ],
      oldStagingArchiveConfirmedOnline: true,
      partialInventoryWarnings: archiveSections.filter((section) => !section.ok).map((section) => ({
        error: section.error,
        name: section.name,
      })),
      rowCountTables: rowCounts.ok ? rowCounts.value.length : 0,
      selectedInventoryTables: selectedTableInventories.ok ? selectedTableInventories.value.tables.length : 0,
      status: archiveSections.every((section) => section.ok)
        ? "ARCHIVE_PRESERVED_INVENTORY_COMPLETE"
        : "ARCHIVE_PRESERVED_WITH_INVENTORY_WARNINGS",
      target: {
        databaseHost: target.databaseHost,
        environment: target.environment,
        supabaseHost: target.supabaseHost,
      },
    };
    writeJson(path.join(archiveDir, "manifest.json"), manifest);
    return manifest;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function backupCurrentStaging() {
  const target = assertTarget("current");
  const sql = createSql(target);
  const backupId = `current-staging-${nowStamp()}`;
  const backupDir = path.join(outputRoot, backupId);
  mkdirSync(backupDir, { recursive: true });

  const tempRoot = createTempSupabaseProject();
  try {
    const [rowCounts, migrationHistory, authMetadata, storageMetadata] = await Promise.all([
      collectRowCounts(sql),
      collectMigrationHistory(sql),
      collectAuthMetadata(sql),
      collectStorageMetadata(sql),
    ]);

    writeJson(path.join(backupDir, "row-counts.json"), rowCounts);
    writeJson(path.join(backupDir, "migration-history.json"), migrationHistory);
    writeJson(path.join(backupDir, "auth-metadata.json"), authMetadata);
    writeJson(path.join(backupDir, "storage-metadata.json"), storageMetadata);

    const dumps = {
      data: runSupabaseCli(["db", "dump", "--db-url", target.databaseUrl, "--data-only", "--use-copy", "--file", path.resolve(backupDir, "public-data.sql")], tempRoot),
      migrationHistory: runSupabaseCli(["db", "dump", "--db-url", target.databaseUrl, "--schema", "supabase_migrations", "--data-only", "--use-copy", "--file", path.resolve(backupDir, "supabase-migrations-data.sql")], tempRoot),
      roles: runSupabaseCli(["db", "dump", "--db-url", target.databaseUrl, "--role-only", "--file", path.resolve(backupDir, "roles.sql")], tempRoot),
      schema: runSupabaseCli(["db", "dump", "--db-url", target.databaseUrl, "--file", path.resolve(backupDir, "schema.sql")], tempRoot),
    };

    const sensitiveAuthExportRequested = optionalEnv("PHOENIX_CONFIRM_STAGING_SENSITIVE_AUTH_EXPORT") === "YES_EXPORT_AUTH_SECRETS";
    const sensitiveAuthDump = sensitiveAuthExportRequested
      ? runSupabaseCli(["db", "dump", "--db-url", target.databaseUrl, "--schema", "auth", "--data-only", "--use-copy", "--file", path.resolve(backupDir, "auth-sensitive-data.sql")], tempRoot)
      : null;

    const cliDumpsOk = Object.values(dumps).every((result) => result.ok) && (sensitiveAuthDump?.ok ?? true);
    const manifest = {
      backupComplete: cliDumpsOk,
      backupDir,
      backupId,
      createdAt: new Date().toISOString(),
      dumps,
      gitStatus: gitStatus(),
      localMigrationCount: localMigrations().length,
      notes: [
        "Current staging was only read. No reset, repair, delete, or migration apply was executed.",
        "Old staging must remain online until this backup is reviewed and the new staging target is validated.",
        "Storage binary object contents are not included in database dumps.",
      ],
      rowCountTables: rowCounts.length,
      sensitiveAuthDump,
      target: {
        databaseHost: target.databaseHost,
        environment: target.environment,
        supabaseHost: target.supabaseHost,
      },
    };
    writeJson(path.join(backupDir, "manifest.json"), manifest);
    return manifest;
  } finally {
    await sql.end({ timeout: 5 });
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function findBackupManifest(backupId: string) {
  const manifestPath = path.join(outputRoot, backupId, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Backup/archive manifest not found at ${manifestPath}. Run backup-current or archive-current first.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    archivePreserved?: boolean;
    backupComplete?: boolean;
    oldStagingArchiveConfirmedOnline?: boolean;
  };
  if (manifest.backupComplete === true) return manifestPath;
  if (manifest.archivePreserved === true && manifest.oldStagingArchiveConfirmedOnline === true) return manifestPath;
  throw new Error(`Backup/archive manifest ${manifestPath} is not complete or archive-preserved. Refusing new-staging apply.`);
}

async function assertOldStagingArchiveOnline() {
  assertOldStagingArchiveConfirmation();
  const target = assertTarget("current");
  const sql = createSql(target);
  try {
    const result = await sql<Array<{ ok: number }>>`select 1 as ok`;
    if (result[0]?.ok !== 1) {
      throw new Error("Current staging archive health check did not return ok.");
    }
    return {
      databaseHost: target.databaseHost,
      environment: target.environment,
      status: "OLD_STAGING_ARCHIVE_ONLINE",
      supabaseHost: target.supabaseHost,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function verifyNewStaging(postApply = false) {
  const target = assertTarget("new");
  const sql = createSql(target);
  try {
    const migrations = localMigrations();
    const history = await sql<Array<{ version: string }>>`
      select version::text
      from supabase_migrations.schema_migrations
      order by version
    `;
    const remoteVersions = new Set(history.map((row) => row.version));
    const missing = migrations.filter((migration) => !remoteVersions.has(migration.version));

    const rpcGrantChecks = postApply ? await sql<Array<{
      anon_can_execute: boolean;
      authenticated_can_execute: boolean;
      exists: boolean;
      function_name: string;
      service_role_can_execute: boolean;
    }>>`
      select
        expected.function_name,
        p.oid is not null as exists,
        coalesce(has_function_privilege('service_role', p.oid, 'execute'), false) as service_role_can_execute,
        coalesce(has_function_privilege('anon', p.oid, 'execute'), false) as anon_can_execute,
        coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false) as authenticated_can_execute
      from unnest(${executiveRpcNames}::text[]) as expected(function_name)
      left join pg_namespace n on n.nspname = 'public'
      left join pg_proc p on p.proname = expected.function_name and p.pronamespace = n.oid
    ` : [];

    return {
      executiveMigrationApplied: remoteVersions.has(executiveMigrationVersion),
      expectedMigrationCount: migrations.length,
      missingMigrationSamples: missing.slice(0, 20),
      missingMigrations: missing.length,
      newTarget: {
        databaseHost: target.databaseHost,
        environment: target.environment,
        supabaseHost: target.supabaseHost,
      },
      postApply,
      rpcGrantsRestricted: postApply
        ? rpcGrantChecks.every((row) => row.exists && row.service_role_can_execute && !row.anon_can_execute && !row.authenticated_can_execute)
        : null,
      rpcGrantChecks,
      status: postApply && missing.length === 0 && remoteVersions.has(executiveMigrationVersion)
        ? "NEW_STAGING_MIGRATION_HISTORY_CLEAN"
        : "NEW_STAGING_NOT_FULLY_APPLIED",
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function dryRunNewStaging() {
  const target = assertTarget("new");
  return {
    dryRun: runSupabaseCliInTemp(["db", "push", "--db-url", target.databaseUrl, "--dry-run"]),
    newTarget: {
      databaseHost: target.databaseHost,
      environment: target.environment,
      supabaseHost: target.supabaseHost,
    },
    noIncludeAll: true,
  };
}

async function applyNewStaging() {
  const target = assertTarget("new");
  const backupId = requiredEnv("PHOENIX_STAGING_BACKUP_ID");
  const manifestPath = findBackupManifest(backupId);
  if (requiredEnv("PHOENIX_CONFIRM_NEW_STAGING_MIGRATION_APPLY") !== "YES_APPLY_FULL_CHAIN_TO_NEW_STAGING") {
    throw new Error("PHOENIX_CONFIRM_NEW_STAGING_MIGRATION_APPLY must be YES_APPLY_FULL_CHAIN_TO_NEW_STAGING.");
  }
  const oldStagingArchive = await assertOldStagingArchiveOnline();
  return {
    apply: runSupabaseCliInTemp(["db", "push", "--db-url", target.databaseUrl, "--yes"]),
    backupManifest: manifestPath,
    newTarget: {
      databaseHost: target.databaseHost,
      environment: target.environment,
      supabaseHost: target.supabaseHost,
    },
    noIncludeAll: true,
    oldStagingArchive,
  };
}

function planReport() {
  return {
    gitStatus: gitStatus(),
    modes: {
      applyNewStaging: "Requires --apply-new-staging, PHOENIX_STAGING_BACKUP_ID, PHOENIX_CONFIRM_OLD_STAGING_ARCHIVE_ONLINE=YES_OLD_STAGING_REMAINS_ONLINE, PHOENIX_CONFIRM_NEW_STAGING_MIGRATION_APPLY=YES_APPLY_FULL_CHAIN_TO_NEW_STAGING.",
      archiveCurrent: "Run --archive-current-staging to create an archive-preserved metadata manifest when full CLI dumps are not reliable.",
      backupCurrent: "Optional full dump path. Run --backup-current-staging if full Supabase CLI dumps are known to complete.",
      dryRunNewStaging: "Run --dry-run-new-staging after setting PHOENIX_NEW_STAGING_* env values.",
      postApplyVerify: "Run --post-apply-verify-new after applying the full chain to new staging.",
    },
    policy: {
      archivePreservedGateAccepted: true,
      currentStagingPreserved: true,
      noDbReset: true,
      noDeleteOldStaging: true,
      noLiveIncludeAll: true,
      productionExcluded: true,
    },
  };
}

async function main() {
  const envLoad = loadLocalEnvFile();
  let result: unknown;

  if (process.argv.includes("--archive-current-staging")) {
    result = await createArchivePreservedManifest();
  } else if (process.argv.includes("--backup-current-staging")) {
    result = await backupCurrentStaging();
  } else if (process.argv.includes("--dry-run-new-staging")) {
    result = dryRunNewStaging();
  } else if (process.argv.includes("--apply-new-staging")) {
    result = await applyNewStaging();
  } else if (process.argv.includes("--post-apply-verify-new")) {
    result = await verifyNewStaging(true);
  } else if (process.argv.includes("--verify-new-staging")) {
    result = await verifyNewStaging(false);
  } else {
    result = planReport();
  }

  console.log(JSON.stringify({
    envLoad,
    result,
    status: "STAGING_REBUILD_SAFETY_TOOL_COMPLETED",
  }, null, 2));
}

await main().catch((error) => {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    noCurrentStagingResetExecuted: true,
    noOldStagingDeletionExecuted: true,
    noProductionActionExecuted: true,
  }, null, 2));
  process.exitCode = 1;
});
