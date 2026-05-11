import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

type MigrationStatus = "PASS" | "FAIL" | "SKIP";

type MigrationResult = {
  detail: string;
  file: string;
  status: MigrationStatus;
};

const localEnvPath = ".env.staging.rls.local";
const sandboxRef = "oaifhavixhdtwmseshff";
const sandboxUrl = `https://${sandboxRef}.supabase.co`;
const productionRef = "ozucdzovmcqvepbozvqf";
const requiredTables = [
  "employees",
  "app_auth_users",
  "user_access_profiles",
  "salary_records",
  "salary_batches",
  "payroll_expenses",
  "payroll_expense_reports",
];

const baseMigrations = [
  "supabase/phoenix-sales-manager-hr-id.sql",
  "supabase/phoenix-core-employee-payroll-schema.sql",
  "supabase/phoenix-payroll-expenses.sql",
  "supabase/phoenix-rbac-access-control.sql",
  "supabase/phoenix-app-auth-admin-user.sql",
  "supabase/phoenix-dynamic-permissions-rls.sql",
  "supabase/security-hardening-phase-1.sql",
  "supabase/phoenix-user-scoped-auth-rls-reconciliation.sql",
  "supabase/20260509_employee_password_setup_links.sql",
  "supabase/20260509_live_admin_auth_security_repair.sql",
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

function loadLocalEnvFile(path: string) {
  if (!existsSync(path)) return { loadedKeys: 0, status: "not_found" as const };
  const source = readFileSync(path, "utf8");
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
  return { loadedKeys, status: "found" as const };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertSafety() {
  if (requiredEnv("PHOENIX_CONFIRM_STAGING_RLS_RUN") !== "YES_STAGING_ONLY") {
    throw new Error("PHOENIX_CONFIRM_STAGING_RLS_RUN must be YES_STAGING_ONLY.");
  }
  if (requiredEnv("PHOENIX_RLS_FREE_ONLY") !== "1") {
    throw new Error("PHOENIX_RLS_FREE_ONLY must be 1.");
  }
  if (process.env.PHOENIX_RLS_ALLOW_PAID_BRANCH === "1") {
    throw new Error("PHOENIX_RLS_ALLOW_PAID_BRANCH must be 0 or unset.");
  }
  const environment = requiredEnv("PHOENIX_STAGING_ENVIRONMENT").toLowerCase();
  if (environment === "production" || environment === "prod" || environment.includes("production")) {
    throw new Error("Refusing production environment.");
  }
  if (!/(staging|stage|dev|test|local|preview)/i.test(environment)) {
    throw new Error("PHOENIX_STAGING_ENVIRONMENT must be staging/dev/test/local.");
  }

  const supabaseUrl = requiredEnv("PHOENIX_STAGING_SUPABASE_URL");
  const supabaseHostname = new URL(supabaseUrl).hostname.toLowerCase();
  if (supabaseUrl !== sandboxUrl || supabaseHostname !== `${sandboxRef}.supabase.co`) {
    throw new Error("Refusing any Supabase URL except the approved Phoenix RLS testing sandbox.");
  }
  if (supabaseUrl.includes(productionRef)) {
    throw new Error("Refusing Phoenix HR production project ref.");
  }

  requiredEnv("PHOENIX_STAGING_SUPABASE_ANON_KEY");
  const databaseUrl = requiredEnv("PHOENIX_STAGING_DATABASE_URL");
  if (databaseUrl.includes(productionRef)) {
    throw new Error("Refusing Phoenix HR production database URL.");
  }
  if (!databaseUrl.includes(sandboxRef)) {
    throw new Error("Database URL must contain the approved sandbox ref.");
  }

  const databaseHostname = new URL(databaseUrl).hostname.toLowerCase();
  const directHost = databaseHostname === `db.${sandboxRef}.supabase.co`;
  const poolerHost =
    databaseHostname.endsWith(".pooler.supabase.com") && databaseUrl.includes(`postgres.${sandboxRef}`);
  if (!directHost && !poolerHost) {
    throw new Error("Database URL must target the approved sandbox direct host or pooler user.");
  }

  return { databaseHostname, environment, supabaseHostname };
}

function createSql() {
  return postgres(requiredEnv("PHOENIX_STAGING_DATABASE_URL"), {
    idle_timeout: 20,
    max: 1,
    ssl: "require",
  });
}

async function tablePresence(sql: postgres.Sql) {
  const rows = await sql<{ exists: boolean; table_name: string }[]>`
    select
      required.table_name,
      to_regclass(format('public.%I', required.table_name)) is not null as exists
    from unnest(${requiredTables}::text[]) as required(table_name)
    order by required.table_name
  `;
  return rows;
}

async function ensureBootstrapMarker(sql: postgres.Sql) {
  await sql`
    create table if not exists public._phoenix_rls_sandbox_bootstrap_marker (
      id bigint generated by default as identity primary key,
      sandbox_ref text not null,
      migration_file text not null,
      status text not null,
      detail text null,
      applied_at timestamptz not null default now()
    )
  `;
}

function assertMigrationFilesExist() {
  const missing = baseMigrations.filter((file) => !existsSync(file));
  if (missing.length) {
    throw new Error(`Required base migration files are missing: ${missing.join(", ")}`);
  }
}

function hasNonIdempotentRisk(source: string) {
  const lower = source.toLowerCase();
  return (
    lower.includes("drop table ") ||
    lower.includes("drop schema ") ||
    lower.includes("truncate table public.") ||
    lower.includes("delete from public.")
  );
}

async function applyMigration(sql: postgres.Sql, file: string): Promise<MigrationResult> {
  const source = await readFile(file, "utf8");
  if (hasNonIdempotentRisk(source)) {
    return {
      detail: "non-idempotent destructive pattern detected; human review required",
      file,
      status: "SKIP",
    };
  }

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(source);
      await tx`
        insert into public._phoenix_rls_sandbox_bootstrap_marker (sandbox_ref, migration_file, status, detail)
        values (${sandboxRef}, ${file}, 'applied', 'completed')
      `;
    });
    return { detail: "applied", file, status: "PASS" };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      file,
      status: "FAIL",
    };
  }
}

function printMigrationPlan() {
  console.log("Required base migrations before role alignment:");
  baseMigrations.forEach((file, index) => {
    console.log(`  ${index + 1}. ${file}`);
  });
}

async function main() {
  const loadInfo = loadLocalEnvFile(localEnvPath);
  console.log(
    loadInfo.status === "found"
      ? `PASS loaded ${localEnvPath} (${loadInfo.loadedKeys} keys, secrets not printed)`
      : `WARN ${localEnvPath} not found; using process environment only`,
  );

  const safety = assertSafety();
  console.log(`PASS sandbox safety gates; host=${safety.supabaseHostname}; dbHost=${safety.databaseHostname}`);
  console.log("PASS free-only mode; no project or branch creation is performed");

  assertMigrationFilesExist();
  printMigrationPlan();

  const sql = createSql();
  try {
    await sql`select 1`;
    console.log("PASS database connection test");

    const before = await tablePresence(sql);
    const existingCount = before.filter((row) => row.exists).length;
    console.log(`Schema probe before bootstrap: ${existingCount}/${requiredTables.length} required tables exist`);
    for (const row of before) {
      console.log(`${row.exists ? "PASS" : "MISSING"} table ${row.table_name}`);
    }

    if (existingCount === requiredTables.length) {
      console.log("PASS sandbox already has required Phoenix base schema tables");
      return;
    }

    await ensureBootstrapMarker(sql);
    console.log("PASS bootstrap marker table ready");

    const results: MigrationResult[] = [];
    for (const file of baseMigrations) {
      const migrationResult = await applyMigration(sql, file);
      results.push(migrationResult);
      console.log(`${migrationResult.status} ${migrationResult.file} - ${migrationResult.detail}`);
      if (migrationResult.status === "FAIL" || migrationResult.status === "SKIP") {
        process.exitCode = 1;
        return;
      }
    }

    const after = await tablePresence(sql);
    const afterExistingCount = after.filter((row) => row.exists).length;
    console.log(`Schema probe after bootstrap: ${afterExistingCount}/${requiredTables.length} required tables exist`);
    for (const row of after) {
      console.log(`${row.exists ? "PASS" : "MISSING"} table ${row.table_name}`);
    }

    if (afterExistingCount !== requiredTables.length) {
      console.log("FAIL bootstrap completed but required Phoenix tables are still missing");
      process.exitCode = 1;
      return;
    }

    console.log("PASS Phoenix sandbox base schema bootstrap complete");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL database connection/bootstrap blocked: ${message}`);
    if (/Tenant or user not found/i.test(message)) {
      console.log(
        "BLOCKER copy the exact sandbox Dashboard pooler URI from Project Settings > Database > Connection string > Transaction pooler/Session pooler URI.",
      );
    }
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
