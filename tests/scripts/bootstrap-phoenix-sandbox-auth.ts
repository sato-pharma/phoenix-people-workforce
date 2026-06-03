import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import postgres from "postgres";

const localEnvPath = ".env.staging.rls.local";
const sandboxRef = "oaifhavixhdtwmseshff";
const productionRef = "ozucdzovmcqvepbozvqf";
const adminLoginId = "admin-HR";
const adminHrId = "RLS-ADMIN-HR";
const marker = "PHX_RLS_SANDBOX_BOOTSTRAP";

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

function approvedStagingRef() {
  return process.env.PHOENIX_APPROVED_STAGING_REF?.trim() || sandboxRef;
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

  const supabaseUrl = requiredEnv("PHOENIX_STAGING_SUPABASE_URL");
  const supabaseHostname = new URL(supabaseUrl).hostname.toLowerCase();
  const approvedRef = approvedStagingRef();
  const sandboxUrl = `https://${approvedRef}.supabase.co`;
  if (supabaseUrl !== sandboxUrl || supabaseHostname !== `${approvedRef}.supabase.co`) {
    throw new Error("Refusing any Supabase URL except the approved Phoenix RLS testing sandbox.");
  }
  if (supabaseUrl.includes(productionRef)) {
    throw new Error("Refusing Phoenix HR production project ref.");
  }

  const databaseUrl = requiredEnv("PHOENIX_STAGING_DATABASE_URL");
  if (databaseUrl.includes(productionRef)) {
    throw new Error("Refusing Phoenix HR production database URL.");
  }
  if (!databaseUrl.includes(approvedRef)) {
    throw new Error("Database URL must contain the approved sandbox ref.");
  }
  const databaseHostname = new URL(databaseUrl).hostname.toLowerCase();
  const directHost = databaseHostname === `db.${approvedRef}.supabase.co`;
  const poolerHost =
    databaseHostname.endsWith(".pooler.supabase.com") && databaseUrl.includes(`postgres.${approvedRef}`);
  if (!directHost && !poolerHost) {
    throw new Error("Database URL must target the approved sandbox direct host or pooler user.");
  }

  requiredEnv("PHOENIX_RLS_ADMIN_PASSWORD");
  return { databaseHostname, supabaseHostname };
}

function createSql() {
  return postgres(requiredEnv("PHOENIX_STAGING_DATABASE_URL"), {
    idle_timeout: 20,
    max: 1,
    ssl: "require",
  });
}

function buildPhoenixAuthEmail(loginId: string) {
  const encodedLoginId = Buffer.from(loginId.trim().toLowerCase()).toString("hex");
  return `phx-${encodedLoginId}@auth.phoenix.local`;
}

async function tableColumns(sql: postgres.Sql, tableName: string, schemaName = "public") {
  const rows = await sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = ${schemaName}
      and table_name = ${tableName}
  `;
  return new Set(rows.map((row) => row.column_name));
}

function requireColumns(tableName: string, actual: Set<string>, required: string[]) {
  const missing = required.filter((column) => !actual.has(column));
  if (missing.length) throw new Error(`${tableName} is missing required columns: ${missing.join(", ")}`);
}

function filterPayload(payload: Record<string, unknown>, columns: Set<string>) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => columns.has(key)));
}

async function ensureLine(sql: postgres.Sql) {
  const rows = await sql<{ id: number }[]>`
    select id
    from public.lines
    where lower(name) = lower('Office')
    limit 1
  `;
  if (rows[0]) return rows[0].id;
  const inserted = await sql<{ id: number }[]>`
    insert into public.lines (name, code)
    values ('Office', 'RLS-OFFICE')
    on conflict (name) do update set updated_at = now()
    returning id
  `;
  return inserted[0].id;
}

async function bootstrapAdmin(sql: postgres.Sql) {
  const appColumns = await tableColumns(sql, "app_auth_users");
  const employeeColumns = await tableColumns(sql, "employees");
  const profileColumns = await tableColumns(sql, "user_access_profiles");
  const authUserColumns = await tableColumns(sql, "users", "auth");
  const identityColumns = await tableColumns(sql, "identities", "auth");

  requireColumns("app_auth_users", appColumns, ["login_id", "password_hash", "role", "hr_id", "is_active"]);
  requireColumns("employees", employeeColumns, ["hr_id", "full_name", "employment_status"]);
  requireColumns("user_access_profiles", profileColumns, ["auth_user_id", "hr_id", "role", "is_active"]);
  requireColumns("auth.users", authUserColumns, ["id", "email", "encrypted_password", "raw_app_meta_data", "raw_user_meta_data"]);
  requireColumns("auth.identities", identityColumns, ["provider_id", "user_id", "identity_data", "provider"]);

  const existingAppUser = await sql<{ auth_user_id: string | null; is_active: boolean; login_id: string; role: string }[]>`
    select login_id, role, is_active, auth_user_id
    from public.app_auth_users
    where lower(login_id) = lower(${adminLoginId})
    limit 1
  `;
  if (existingAppUser[0]) {
    const user = existingAppUser[0];
    if (user.role !== "Super Admin") {
      throw new Error(`admin-HR already exists with role ${user.role}; refusing to overwrite an existing user.`);
    }
    if (!user.is_active) {
      throw new Error("admin-HR already exists but is inactive; refusing to overwrite an existing user.");
    }
    return { authUserId: user.auth_user_id, created: false };
  }

  const authEmail = buildPhoenixAuthEmail(adminLoginId);
  const existingAuthEmail = await sql<{ id: string; raw_app_meta_data: unknown }[]>`
    select id, raw_app_meta_data
    from auth.users
    where lower(email) = lower(${authEmail})
    limit 1
  `;
  if (existingAuthEmail[0]) {
    throw new Error("Supabase Auth bridge email already exists without app_auth_users; refusing to overwrite.");
  }

  const lineId = await ensureLine(sql);
  const passwordHash = await bcrypt.hash(requiredEnv("PHOENIX_RLS_ADMIN_PASSWORD"), 12);
  const authUserId = randomUUID();
  const now = new Date();

  const employeeExisting = await sql<{ hr_id: string }[]>`
    select hr_id
    from public.employees
    where lower(hr_id) = lower(${adminHrId})
    limit 1
  `;
  if (!employeeExisting[0]) {
    const employeePayload = filterPayload(
      {
        comment: marker,
        employment_status: "active",
        full_name: "PHX RLS Sandbox Bootstrap Admin",
        hr_id: adminHrId,
        job_title: "Super Admin",
        line_id: lineId,
        notes: marker,
        updated_at: now,
      },
      employeeColumns,
    );
    await sql`insert into public.employees ${sql({ ...employeePayload, created_at: now })}`;
  }

  const appMeta = {
    access_scope: "SUPER_ADMIN",
    coarse_access_role: "admin",
    hr_id: adminHrId,
    is_active: true,
    line: "Office",
    login_id: adminLoginId,
    phoenix_role: "Super Admin",
    provider: "email",
    providers: ["email"],
  };
  const userMeta = {
    hr_id: adminHrId,
    line: "Office",
    login_id: adminLoginId,
    name: "PHX RLS Sandbox Bootstrap Admin",
    phoenix_role: "Super Admin",
  };

  const appUserPayload = filterPayload(
    {
      auth_email: authEmail,
      auth_user_id: authUserId,
      force_password_reset: false,
      hr_id: adminHrId,
      is_active: true,
      line: "Office",
      login_id: adminLoginId,
      manager_hr_id: null,
      name: "PHX RLS Sandbox Bootstrap Admin",
      password_hash: passwordHash,
      role: "Super Admin",
      session_version: 1,
      updated_at: now,
    },
    appColumns,
  );

  await sql`
    insert into auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      invited_at,
      confirmation_token,
      confirmation_sent_at,
      recovery_token,
      email_change_token_new,
      email_change,
      email_change_sent_at,
      last_sign_in_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      is_super_admin,
      is_sso_user,
      is_anonymous
    )
    values (
      '00000000-0000-0000-0000-000000000000',
      ${authUserId},
      'authenticated',
      'authenticated',
      ${authEmail},
      crypt(${requiredEnv("PHOENIX_RLS_ADMIN_PASSWORD")}, gen_salt('bf')),
      now(),
      now(),
      '',
      now(),
      '',
      '',
      '',
      now(),
      now(),
      ${sql.json(appMeta)},
      ${sql.json(userMeta)},
      now(),
      now(),
      false,
      false,
      false
    )
  `;

  await sql`
    delete from auth.identities
    where provider = 'email'
      and user_id = ${authUserId}
  `;

  const identityPayload = filterPayload(
    {
      provider_id: authEmail,
      user_id: authUserId,
      identity_data: { email: authEmail, email_verified: true, sub: authUserId },
      provider: "email",
      last_sign_in_at: null,
      created_at: now,
      updated_at: now,
    },
    identityColumns,
  );
  await sql`insert into auth.identities ${sql(identityPayload)}`;

  await sql`insert into public.app_auth_users ${sql({ ...appUserPayload, created_at: now })}`;

  const profilePayload = filterPayload(
    {
      auth_user_id: authUserId,
      created_at: now,
      hr_id: adminHrId,
      is_active: true,
      line: "Office",
      login_id: adminLoginId,
      manager_hr_id: null,
      phoenix_role: "Super Admin",
      role: "admin",
      scope_type: "SUPER_ADMIN",
      updated_at: now,
    },
    profileColumns,
  );
  await sql`insert into public.user_access_profiles ${sql(profilePayload)}`;

  return { authUserId, created: true };
}

async function ensureSupabaseAuthInternalGrants(sql: postgres.Sql) {
  await sql`
    grant usage on schema auth to supabase_auth_admin
  `;
  await sql`
    grant all privileges on all tables in schema auth to supabase_auth_admin
  `;
  await sql`
    grant all privileges on all sequences in schema auth to supabase_auth_admin
  `;
  await sql`
    grant all privileges on all routines in schema auth to supabase_auth_admin
  `;
}

async function verifyAdmin(sql: postgres.Sql) {
  const rows = await sql<{ auth_user_id: string | null; is_active: boolean; login_id: string; role: string }[]>`
    select login_id, role, is_active, auth_user_id
    from public.app_auth_users
    where lower(login_id) = lower(${adminLoginId})
    limit 1
  `;
  const admin = rows[0];
  if (!admin) throw new Error("admin-HR was not found after bootstrap.");
  if (admin.role !== "Super Admin") throw new Error(`admin-HR role is ${admin.role}; expected Super Admin.`);
  if (!admin.is_active) throw new Error("admin-HR exists but is inactive.");
  if (!admin.auth_user_id) throw new Error("admin-HR is missing auth_user_id linkage.");

  const profileRows = await sql<{ count: number }[]>`
    select count(*)::integer as count
    from public.user_access_profiles
    where auth_user_id = ${admin.auth_user_id}
      and hr_id = ${adminHrId}
      and is_active = true
  `;
  if ((profileRows[0]?.count ?? 0) < 1) {
    throw new Error("admin-HR user_access_profiles linkage was not found.");
  }

  return admin;
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

  const sql = createSql();
  try {
    await sql`select 1`;
    console.log("PASS database connection test");

    await ensureSupabaseAuthInternalGrants(sql);
    console.log("PASS verified sandbox Supabase Auth internal grants");

    const result = await bootstrapAdmin(sql);
    console.log(result.created ? "PASS created sandbox admin-HR" : "PASS admin-HR already exists; no overwrite");

    await verifyAdmin(sql);
    console.log("PASS admin-HR exists, is active, and is linked to Supabase Auth/user_access_profiles");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
