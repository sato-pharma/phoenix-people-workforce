import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import postgres from "postgres";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "staging-executive-dashboard-migration-reconciliation",
  entry: import.meta.url,
  known: ["--skip-cli-dry-run", "--post-apply-verify", "--repair-verified-history", "--apply-executive-migration", "--verbose"],
});

type Migration = {
  fileName: string;
  name: string;
  path: string;
  sql: string;
  version: string;
};

type RemoteMigration = {
  name: string | null;
  version: string;
};

type ParsedMigration = {
  functions: string[];
  hasTopLevelDataMutation: boolean;
  hasTopLevelDestructiveStatement: boolean;
  policies: Array<{ policy: string; schema: string; table: string }>;
  rlsTables: string[];
  tables: string[];
};

type ParityResult = ParsedMigration & {
  blockingReasons: string[];
  missingFunctions: string[];
  missingPolicies: string[];
  missingRlsTables: string[];
  missingTables: string[];
  repairStatus: "verified" | "blocked";
};

type DryRunResult = {
  command: string;
  ok: boolean;
  output: string;
};

type MigrationSummary = {
  fileName: string;
  name: string;
  parity: ParityResult;
  version: string;
};

type ReconciliationReport = {
  applyPolicy: {
    ceoMigrationMayBeApplied: boolean;
    targetMigration: string;
  };
  blockedHistoricalMigrations: MigrationSummary[];
  dryRuns: {
    includeAll: DryRunResult;
    normal: DryRunResult;
  } | null;
  envLoad: {
    loadedKeys: number;
    path: string;
  };
  migrationHistory: {
    missingHistoricalCount: number;
    remoteCount: number;
    targetAlreadyApplied: boolean;
    verifiedHistoricalCount: number;
  };
  postApplyVerification: Awaited<ReturnType<typeof verifyExecutiveMigration>> | null;
  safety: {
    noLiveIncludeAll: boolean;
    productionRefBlocked: string;
    stagingOnly: boolean;
    target: {
      databaseHost: string;
      environment: string;
      supabaseHost: string;
    };
  };
  verifiedHistoricalMigrations: MigrationSummary[];
};

const localEnvPath = ".env.staging.rls.local";
const blockedProductionRef = "ozucdzovmcqvepbozvqf";

/**
 * The only project this script may reconcile. AGENTS.md section 3.
 *
 * PHOENIX_APPROVED_STAGING_REF stays REQUIRED and still fails closed when absent — that half of
 * the design predates this constant and is deliberate: a hardcoded ref with nothing checking it
 * is exactly how the retired oaifhavixhdtwmseshff sandbox rotted in place here unnoticed.
 *
 * What the variable must not be able to do is REDIRECT the run. Until 2026-09-04 it could name
 * ANY project and this script would reconcile it, and the account can see two that have nothing
 * to do with this app — one of which, that same day, this checkout's Supabase CLI was actually
 * linked to. So the variable is now a CONFIRMATION, not a choice: it must name this ref or the
 * run stops. That keeps the strong guard's property (an allowlist can be too strict but never
 * too permissive, per apply-migrations-to-staging.ts) without reintroducing silent rot, because
 * tests/supabase-project-refs.test.ts pins this literal against the AGENTS.md section 3 table.
 */
const stagingProjectRef = "cifwmndunmlxjhyjugxa";

/** Named one by one so a refusal says WHICH project it is, not merely "not staging". */
const foreignProjectRefs = new Map<string, string>([
  ["plleofqyfbknvwcotzqo", "Future Talents Hub — unrelated to this app"],
  ["mlbpzvaanusdejqnimst", "the owner's personal project — a DIFFERENT organization"],
]);
const targetVersion = "20260602082351";
const targetMigrationFile = "20260602082351_executive_dashboard_snapshot.sql";
const backupConfirmationEnv = "PHOENIX_CONFIRM_STAGING_BACKUP";
const repairConfirmationEnv = "PHOENIX_CONFIRM_STAGING_MIGRATION_REPAIR";
const applyConfirmationEnv = "PHOENIX_CONFIRM_STAGING_EXECUTIVE_MIGRATION_APPLY";

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

  return { loadedKeys, path: localEnvPath };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

// This is the allowlist gate, so it carries no baked-in default. It used to compare against the
// retired oaifhavixhdtwmseshff sandbox, which is no longer on the Supabase account: that turned
// any run into a confusing "not the approved staging project" refusal against a ref nobody
// recognises, instead of naming the actual problem here.
function approvedStagingRef() {
  const ref = process.env.PHOENIX_APPROVED_STAGING_REF?.trim();
  if (!ref) {
    throw new Error(
      "PHOENIX_APPROVED_STAGING_REF is required. Set it to the approved staging project ref in .env.staging.rls.local.",
    );
  }
  const foreign = foreignProjectRefs.get(ref);
  if (foreign) {
    throw new Error(
      `Refusing: PHOENIX_APPROVED_STAGING_REF names ${ref} — ${foreign}. This script only ever ` +
        `reconciles Phoenix staging (${stagingProjectRef}).`,
    );
  }
  if (ref !== stagingProjectRef) {
    throw new Error(
      `Refusing: PHOENIX_APPROVED_STAGING_REF names ${ref}, which is not Phoenix staging ` +
        `(${stagingProjectRef}). The variable confirms the target; it cannot choose a different ` +
        "one. Fix the value in .env.staging.rls.local — there is no override here and there must " +
        "not be one.",
    );
  }
  return ref;
}

function assertStagingTarget() {
  const confirm = requiredEnv("PHOENIX_CONFIRM_STAGING_RLS_RUN");
  if (confirm !== "YES_STAGING_ONLY") {
    throw new Error('PHOENIX_CONFIRM_STAGING_RLS_RUN must be "YES_STAGING_ONLY".');
  }

  const environment = requiredEnv("PHOENIX_STAGING_ENVIRONMENT").toLowerCase();
  if (!/(staging|stage|preview|dev|test|branch|local)/.test(environment) || environment.includes("production")) {
    throw new Error(`Refusing non-staging environment "${environment}".`);
  }

  const supabaseUrl = requiredEnv("PHOENIX_STAGING_SUPABASE_URL");
  const supabaseHost = new URL(supabaseUrl).hostname.toLowerCase();
  const databaseUrl = requiredEnv("PHOENIX_STAGING_DATABASE_URL");
  const databaseHost = new URL(databaseUrl).hostname.toLowerCase();

  if (
    supabaseUrl.includes(blockedProductionRef) ||
    databaseUrl.includes(blockedProductionRef) ||
    supabaseHost.includes(blockedProductionRef) ||
    databaseHost.includes(blockedProductionRef)
  ) {
    throw new Error("Refusing Phoenix production Supabase project or database.");
  }

  const approvedRef = approvedStagingRef();
  if (!supabaseHost.includes(approvedRef) && !databaseUrl.includes(approvedRef)) {
    throw new Error("Refusing any target except the approved Phoenix staging Supabase project.");
  }

  return {
    databaseHost,
    environment,
    supabaseHost,
  };
}

function stagingDatabaseUrl() {
  const url = new URL(requiredEnv("PHOENIX_STAGING_DATABASE_URL"));
  url.searchParams.set("sslmode", "require");
  url.searchParams.set("default_query_exec_mode", "simple_protocol");
  url.searchParams.set("statement_cache_capacity", "0");
  return url.toString();
}

function localMigrations() {
  return readdirSync("supabase/migrations")
    .map((fileName) => {
      const match = fileName.match(/^(\d{14})_(.+)\.sql$/);
      if (!match) return null;
      const filePath = path.join("supabase", "migrations", fileName);
      return {
        fileName,
        name: match[2],
        path: filePath,
        sql: readFileSync(filePath, "utf8"),
        version: match[1],
      } satisfies Migration;
    })
    .filter((migration): migration is Migration => Boolean(migration))
    .sort((a, b) => a.version.localeCompare(b.version));
}

function stripDollarQuotedBodies(sql: string) {
  return sql
    .replace(/\$[a-zA-Z0-9_]*\$[\s\S]*?\$[a-zA-Z0-9_]*\$/g, "$$BODY$$")
    .replace(/'([^']|'')*'/g, "'literal'");
}

function collectMatches(source: string, pattern: RegExp, build: (match: RegExpExecArray) => string) {
  const values = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    values.add(build(match).toLowerCase());
  }
  return [...values].sort();
}

function parseMigration(sql: string): ParsedMigration {
  const withoutBodies = stripDollarQuotedBodies(sql);
  const tables = new Set<string>([
    ...collectMatches(withoutBodies, /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][\w]*)\.([a-z_][\w]*)/gi, (match) => `${match[1]}.${match[2]}`),
    ...collectMatches(withoutBodies, /\balter\s+table\s+(?:if\s+exists\s+)?([a-z_][\w]*)\.([a-z_][\w]*)/gi, (match) => `${match[1]}.${match[2]}`),
  ]);
  const rlsTables = collectMatches(withoutBodies, /\balter\s+table\s+(?:if\s+exists\s+)?([a-z_][\w]*)\.([a-z_][\w]*)\s+(?:force\s+)?enable\s+row\s+level\s+security/gi, (match) => `${match[1]}.${match[2]}`);
  const functions = collectMatches(withoutBodies, /\bcreate\s+(?:or\s+replace\s+)?function\s+([a-z_][\w]*)\.([a-z_][\w]*)\s*\(/gi, (match) => `${match[1]}.${match[2]}`);
  const policies: ParsedMigration["policies"] = [];
  let policyMatch: RegExpExecArray | null;
  const policyPattern = /\bcreate\s+policy\s+("?[^"\n]+"?|[a-z_][\w]*)\s+on\s+([a-z_][\w]*)\.([a-z_][\w]*)/gi;
  while ((policyMatch = policyPattern.exec(withoutBodies))) {
    policies.push({
      policy: policyMatch[1].replace(/^"|"$/g, "").trim().toLowerCase(),
      schema: policyMatch[2].toLowerCase(),
      table: policyMatch[3].toLowerCase(),
    });
  }

  return {
    functions,
    hasTopLevelDataMutation: /\b(insert\s+into|update|delete\s+from)\s+(auth|public|private)\./i.test(withoutBodies),
    hasTopLevelDestructiveStatement: /\b(drop\s+table|drop\s+schema|truncate\s+table)\b/i.test(withoutBodies),
    policies: policies.sort((a, b) => `${a.schema}.${a.table}.${a.policy}`.localeCompare(`${b.schema}.${b.table}.${b.policy}`)),
    rlsTables,
    tables: [...tables].sort(),
  };
}

async function createSql() {
  return postgres(stagingDatabaseUrl(), {
    max: 1,
    prepare: false,
    ssl: "require",
  });
}

async function remoteMigrations(sql: ReturnType<typeof postgres>) {
  return sql<RemoteMigration[]>`
    select version::text, name::text
    from supabase_migrations.schema_migrations
    order by version
  `;
}

async function tableExists(sql: ReturnType<typeof postgres>, table: string) {
  const rows = await sql<{ exists: boolean }[]>`
    select to_regclass(${table}) is not null as exists
  `;
  return rows[0]?.exists === true;
}

async function functionExists(sql: ReturnType<typeof postgres>, name: string) {
  const [schema, functionName] = name.split(".");
  const rows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ${schema}
        and p.proname = ${functionName}
    ) as exists
  `;
  return rows[0]?.exists === true;
}

async function policyExists(sql: ReturnType<typeof postgres>, policy: ParsedMigration["policies"][number]) {
  const rows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1
      from pg_policies
      where schemaname = ${policy.schema}
        and tablename = ${policy.table}
        and lower(policyname) = ${policy.policy}
    ) as exists
  `;
  return rows[0]?.exists === true;
}

async function rlsEnabled(sql: ReturnType<typeof postgres>, table: string) {
  const [schema, tableName] = table.split(".");
  const rows = await sql<{ enabled: boolean }[]>`
    select coalesce(c.relrowsecurity, false) as enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema}
      and c.relname = ${tableName}
  `;
  return rows[0]?.enabled === true;
}

async function verifyParity(sql: ReturnType<typeof postgres>, migration: Migration): Promise<ParityResult> {
  const parsed = parseMigration(migration.sql);
  const missingTables: string[] = [];
  const missingFunctions: string[] = [];
  const missingPolicies: string[] = [];
  const missingRlsTables: string[] = [];

  for (const table of parsed.tables) {
    if (!await tableExists(sql, table)) missingTables.push(table);
  }
  for (const functionName of parsed.functions) {
    if (!await functionExists(sql, functionName)) missingFunctions.push(functionName);
  }
  for (const policy of parsed.policies) {
    if (!await policyExists(sql, policy)) {
      missingPolicies.push(`${policy.schema}.${policy.table}.${policy.policy}`);
    }
  }
  for (const table of parsed.rlsTables) {
    if (!await rlsEnabled(sql, table)) missingRlsTables.push(table);
  }

  const blockingReasons = [
    missingTables.length > 0 ? "missing table or altered-table target" : null,
    missingFunctions.length > 0 ? "missing function" : null,
    missingPolicies.length > 0 ? "missing policy" : null,
    missingRlsTables.length > 0 ? "RLS not enabled" : null,
    parsed.hasTopLevelDataMutation ? "top-level data mutation requires manual parity proof" : null,
    parsed.hasTopLevelDestructiveStatement ? "top-level destructive statement requires manual parity proof" : null,
    parsed.tables.length === 0 && parsed.functions.length === 0 && parsed.policies.length === 0 && parsed.rlsTables.length === 0
      ? "no schema artifact found for automated parity proof"
      : null,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    ...parsed,
    blockingReasons,
    missingFunctions,
    missingPolicies,
    missingRlsTables,
    missingTables,
    repairStatus: blockingReasons.length === 0 ? "verified" : "blocked",
  };
}

function createTempSupabaseProject() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "phoenix-staging-supabase-"));
  mkdirSync(path.join(tempRoot, "supabase", "migrations"), { recursive: true });
  cpSync(path.join("supabase", "config.toml"), path.join(tempRoot, "supabase", "config.toml"));
  cpSync(path.join("supabase", "migrations"), path.join(tempRoot, "supabase", "migrations"), { recursive: true });
  return tempRoot;
}

function npxExecutable() {
  return process.platform === "win32"
    ? path.resolve("node_modules", "supabase", "bin", "supabase.exe")
    : path.resolve("node_modules", ".bin", "supabase");
}

function redactSecrets(value: string) {
  return value
    .replace(/postgresql:\/\/[^@\s]+@/gi, "postgresql://<redacted>@")
    .replace(/postgres:\/\/[^@\s]+@/gi, "postgres://<redacted>@")
    .replace(/(PHOENIX_STAGING_[A-Z_]*KEY=)[^\s]+/g, "$1<redacted>");
}

function truncateOutput(value: string, maxLength = 4000) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n... truncated ...` : value;
}

function runSupabaseCli(args: string[], cwd: string): DryRunResult {
  const dbUrl = stagingDatabaseUrl();
  const command = `supabase ${args.map((arg) => arg === dbUrl ? "<staging-db-url-redacted>" : arg).join(" ")}`;
  try {
    const output = execFileSync(npxExecutable(), args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { command, ok: true, output: truncateOutput(redactSecrets(output)) };
  } catch (error) {
    const caught = error as { message?: string; stderr?: Buffer | string; stdout?: Buffer | string };
    const output = truncateOutput(redactSecrets(`${caught.stdout?.toString() ?? ""}${caught.stderr?.toString() ?? ""}${caught.message ? `\n${caught.message}` : ""}`.trim()));
    return { command, ok: false, output };
  }
}

function runDryRuns() {
  const tempRoot = createTempSupabaseProject();
  const dbUrl = stagingDatabaseUrl();
  try {
    const normal = runSupabaseCli(["db", "push", "--db-url", dbUrl, "--dry-run"], tempRoot);
    const includeAll = runSupabaseCli(["db", "push", "--db-url", dbUrl, "--dry-run", "--include-all"], tempRoot);
    return { includeAll, normal, tempRoot };
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function dryRunListsOnlyTarget(output: string) {
  const wouldPush = output.match(/\b\d{14}_[^\s]+\.sql\b/g) ?? [];
  return wouldPush.length === 1 && wouldPush[0] === targetMigrationFile;
}

function assertBackupConfirmed() {
  if (process.env[backupConfirmationEnv] !== "YES_BACKUP_CONFIRMED") {
    throw new Error(`${backupConfirmationEnv}=YES_BACKUP_CONFIRMED is required before writing staging migration history.`);
  }
}

function repairMigrations(migrations: MigrationSummary[]) {
  assertBackupConfirmed();
  if (process.env[repairConfirmationEnv] !== "YES_REPAIR_STAGING_HISTORY") {
    throw new Error(`${repairConfirmationEnv}=YES_REPAIR_STAGING_HISTORY is required before migration repair.`);
  }

  const blocked = migrations.filter((migration) => migration.parity.repairStatus !== "verified");
  if (blocked.length > 0) {
    throw new Error(`Refusing repair because ${blocked.length} historical migrations are not parity-verified.`);
  }

  const tempRoot = createTempSupabaseProject();
  try {
    return migrations.map((migration) => runSupabaseCli([
      "migration",
      "repair",
      migration.version,
      "--status",
      "applied",
      "--db-url",
      stagingDatabaseUrl(),
      "--yes",
    ], tempRoot));
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function applyExecutiveMigration(cleanDryRun: DryRunResult) {
  assertBackupConfirmed();
  if (process.env[applyConfirmationEnv] !== "YES_APPLY_EXECUTIVE_DASHBOARD_MIGRATION") {
    throw new Error(`${applyConfirmationEnv}=YES_APPLY_EXECUTIVE_DASHBOARD_MIGRATION is required before applying the CEO migration.`);
  }
  if (!cleanDryRun.ok || !dryRunListsOnlyTarget(cleanDryRun.output)) {
    throw new Error("Refusing apply because clean dry-run does not list only the executive dashboard migration.");
  }

  const tempRoot = createTempSupabaseProject();
  try {
    return runSupabaseCli(["db", "push", "--db-url", stagingDatabaseUrl(), "--yes"], tempRoot);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

async function verifyExecutiveMigration(sql: ReturnType<typeof postgres>) {
  const historyRows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1
      from supabase_migrations.schema_migrations
      where version = ${targetVersion}
    ) as exists
  `;
  const functionRows = await sql<Array<{
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
  `;

  return {
    executiveMigrationRecorded: historyRows[0]?.exists === true,
    rpcGrantChecks: functionRows,
    rpcGrantsRestricted: functionRows.every((row) =>
      row.exists &&
      row.service_role_can_execute &&
      !row.anon_can_execute &&
      !row.authenticated_can_execute
    ),
  };
}

async function buildReport(): Promise<ReconciliationReport> {
  const envLoad = loadLocalEnvFile();
  const target = assertStagingTarget();
  const sql = await createSql();

  try {
    const local = localMigrations();
    const remote = await remoteMigrations(sql);
    const remoteVersions = new Set(remote.map((migration) => migration.version));
    const targetMigration = local.find((migration) => migration.fileName === targetMigrationFile);
    if (!targetMigration) throw new Error(`${targetMigrationFile} is missing from supabase/migrations.`);

    const missingHistorical = local.filter((migration) =>
      migration.version < targetVersion &&
      !remoteVersions.has(migration.version)
    );
    const parity = await Promise.all(missingHistorical.map(async (migration) => ({
      fileName: migration.fileName,
      name: migration.name,
      parity: await verifyParity(sql, migration),
      version: migration.version,
    } satisfies MigrationSummary)));
    const blocked = parity.filter((migration) => migration.parity.repairStatus === "blocked");
    const verified = parity.filter((migration) => migration.parity.repairStatus === "verified");
    const dryRuns = process.argv.includes("--skip-cli-dry-run") ? null : runDryRuns();
    const postApplyVerification = process.argv.includes("--post-apply-verify")
      ? await verifyExecutiveMigration(sql)
      : null;

    return {
      applyPolicy: {
        ceoMigrationMayBeApplied: dryRuns?.normal.ok === true && dryRunListsOnlyTarget(dryRuns.normal.output),
        targetMigration: targetMigrationFile,
      },
      blockedHistoricalMigrations: blocked,
      dryRuns: dryRuns
        ? {
            includeAll: dryRuns.includeAll,
            normal: dryRuns.normal,
          }
        : null,
      envLoad,
      migrationHistory: {
        missingHistoricalCount: parity.length,
        remoteCount: remote.length,
        targetAlreadyApplied: remoteVersions.has(targetVersion),
        verifiedHistoricalCount: verified.length,
      },
      postApplyVerification,
      safety: {
        noLiveIncludeAll: true,
        productionRefBlocked: blockedProductionRef,
        stagingOnly: true,
        target,
      },
      verifiedHistoricalMigrations: verified,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function compactMigrationSummary(migration: MigrationSummary) {
  return {
    blockingReasons: migration.parity.blockingReasons,
    fileName: migration.fileName,
    missingFunctions: migration.parity.missingFunctions.length,
    missingPolicies: migration.parity.missingPolicies.length,
    missingRlsTables: migration.parity.missingRlsTables.length,
    missingTables: migration.parity.missingTables.length,
    name: migration.name,
    repairStatus: migration.parity.repairStatus,
    topLevelDataMutationNeedsManualProof: migration.parity.hasTopLevelDataMutation,
    topLevelDestructiveStatementNeedsManualProof: migration.parity.hasTopLevelDestructiveStatement,
    version: migration.version,
  };
}

function compactReport(report: ReconciliationReport) {
  return {
    applyPolicy: report.applyPolicy,
    blockedHistoricalMigrationSamples: report.blockedHistoricalMigrations.slice(0, 20).map(compactMigrationSummary),
    blockedHistoricalMigrationsOmitted: Math.max(report.blockedHistoricalMigrations.length - 20, 0),
    dryRuns: report.dryRuns,
    envLoad: report.envLoad,
    migrationHistory: report.migrationHistory,
    postApplyVerification: report.postApplyVerification,
    safety: report.safety,
    verifiedHistoricalMigrations: report.verifiedHistoricalMigrations.map((migration) => ({
      fileName: migration.fileName,
      name: migration.name,
      version: migration.version,
    })),
  };
}

async function main() {
  const report = await buildReport();
  let repairResults: DryRunResult[] | null = null;
  let applyResult: DryRunResult | null = null;

  if (process.argv.includes("--repair-verified-history")) {
    repairResults = repairMigrations([
      ...report.verifiedHistoricalMigrations,
      ...report.blockedHistoricalMigrations,
    ]);
  }

  if (process.argv.includes("--apply-executive-migration")) {
    if (!report.dryRuns) throw new Error("Clean dry-run is required before applying the CEO migration.");
    applyResult = applyExecutiveMigration(report.dryRuns.normal);
  }

  const failedRepair = repairResults?.filter((result) => !result.ok) ?? [];
  const reportStatus = report.blockedHistoricalMigrations.length > 0
    ? "BLOCKED_PENDING_MANUAL_PARITY_REVIEW"
    : report.applyPolicy.ceoMigrationMayBeApplied
      ? "READY_TO_APPLY_ONLY_EXECUTIVE_DASHBOARD_MIGRATION"
      : "BLOCKED_UNTIL_CLEAN_DRY_RUN";
  const printableReport = process.argv.includes("--verbose")
    ? report
    : compactReport(report);

  console.log(JSON.stringify({
    ...printableReport,
    applyResult,
    repairResults,
    status: reportStatus,
  }, null, 2));

  if (
    report.blockedHistoricalMigrations.length > 0 ||
    failedRepair.length > 0 ||
    applyResult?.ok === false
  ) {
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    noMigrationHistoryWriteExecutedUnlessExplicitRepairFlagWasUsed: !process.argv.includes("--repair-verified-history"),
    noMigrationApplyExecutedUnlessExplicitApplyFlagWasUsed: !process.argv.includes("--apply-executive-migration"),
  }, null, 2));
  process.exitCode = 1;
});
