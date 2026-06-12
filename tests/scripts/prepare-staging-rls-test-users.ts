import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

type PhoenixRole =
  | "Employee"
  | "Medical Rep"
  | "District Manager"
  | "Regional Manager"
  | "National Sales Manager"
  | "Product Manager"
  | "Group Product Manager"
  | "SFE Manager"
  | "Training Manager"
  | "Marketing Manager"
  | "Finance Manager"
  | "Talent Acquisition"
  | "Manager"
  | "CEO"
  | "Super Admin";

type TestUser = {
  hrId: string;
  loginId: string;
  password: string;
};

type RoleSpec = {
  hrId: string;
  line: string;
  loginId: string;
  managerHrId: string | null;
  role: PhoenixRole;
};

const localEnvPath = ".env.staging.rls.local";
const approvedSandboxRef = "oaifhavixhdtwmseshff";
const blockedProductionRef = "ozucdzovmcqvepbozvqf";
const roles: PhoenixRole[] = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Training Manager",
  "Marketing Manager",
  "Finance Manager",
  "Talent Acquisition",
  "Manager",
  "CEO",
  "Super Admin",
];

const testUserCreationOrder: PhoenixRole[] = [
  "National Sales Manager",
  "Regional Manager",
  "District Manager",
  "Manager",
  "Employee",
  "Medical Rep",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Training Manager",
  "Marketing Manager",
  "Finance Manager",
  "Talent Acquisition",
  "CEO",
  "Super Admin",
];

const roleSpecs: Record<PhoenixRole, RoleSpec> = {
  Employee: {
    hrId: "RLS-EMP-001",
    line: "CNS",
    loginId: "rls-test-employee",
    managerHrId: "RLS-DM-001",
    role: "Employee",
  },
  "Medical Rep": {
    hrId: "RLS-MR-001",
    line: "CNS",
    loginId: "rls-test-medical-rep",
    managerHrId: "RLS-DM-001",
    role: "Medical Rep",
  },
  "District Manager": {
    hrId: "RLS-DM-001",
    line: "CNS",
    loginId: "rls-test-district-manager",
    managerHrId: "RLS-RM-001",
    role: "District Manager",
  },
  "Regional Manager": {
    hrId: "RLS-RM-001",
    line: "CNS",
    loginId: "rls-test-regional-manager",
    managerHrId: "RLS-NSM-001",
    role: "Regional Manager",
  },
  "National Sales Manager": {
    hrId: "RLS-NSM-001",
    line: "CNS",
    loginId: "rls-test-national-sales-manager",
    managerHrId: null,
    role: "National Sales Manager",
  },
  "Product Manager": {
    hrId: "RLS-PM-001",
    line: "CNS",
    loginId: "rls-test-product-manager",
    managerHrId: null,
    role: "Product Manager",
  },
  "Group Product Manager": {
    hrId: "RLS-GPM-001",
    line: "CNS",
    loginId: "rls-test-group-product-manager",
    managerHrId: null,
    role: "Group Product Manager",
  },
  "SFE Manager": {
    hrId: "RLS-SFE-001",
    line: "CNS",
    loginId: "rls-test-sfe-manager",
    managerHrId: null,
    role: "SFE Manager",
  },
  "Training Manager": {
    hrId: "RLS-TRN-001",
    line: "CNS",
    loginId: "rls-test-training-manager",
    managerHrId: null,
    role: "Training Manager",
  },
  "Marketing Manager": {
    hrId: "RLS-MKT-001",
    line: "CNS",
    loginId: "rls-test-marketing-manager",
    managerHrId: null,
    role: "Marketing Manager",
  },
  "Finance Manager": {
    hrId: "RLS-FIN-001",
    line: "Office",
    loginId: "rls-test-finance-manager",
    managerHrId: null,
    role: "Finance Manager",
  },
  "Talent Acquisition": {
    hrId: "RLS-HR-001",
    line: "Office",
    loginId: "rls-test-hr-specialist",
    managerHrId: null,
    role: "Talent Acquisition",
  },
  Manager: {
    hrId: "RLS-MGR-001",
    line: "Office",
    loginId: "rls-test-manager",
    managerHrId: null,
    role: "Manager",
  },
  CEO: {
    hrId: "RLS-CEO-001",
    line: "Office",
    loginId: "rls-test-ceo",
    managerHrId: null,
    role: "CEO",
  },
  "Super Admin": {
    hrId: "RLS-SA-001",
    line: "Office",
    loginId: "rls-test-super-admin",
    managerHrId: null,
    role: "Super Admin",
  },
};

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
  return process.env.PHOENIX_APPROVED_STAGING_REF?.trim() || approvedSandboxRef;
}

function assertStagingSafety() {
  const confirm = requiredEnv("PHOENIX_CONFIRM_STAGING_RLS_RUN");
  if (confirm !== "YES_STAGING_ONLY") {
    throw new Error('PHOENIX_CONFIRM_STAGING_RLS_RUN must be exactly "YES_STAGING_ONLY".');
  }

  const environment = requiredEnv("PHOENIX_STAGING_ENVIRONMENT").toLowerCase();
  if (environment !== "staging" && !/(local|stage|staging|preview|dev|test|branch)/i.test(environment)) {
    throw new Error("PHOENIX_STAGING_ENVIRONMENT must clearly identify staging/non-production.");
  }
  if (environment === "production" || environment === "prod" || environment.includes("production")) {
    throw new Error("Refusing production environment.");
  }

  const supabaseUrl = requiredEnv("PHOENIX_STAGING_SUPABASE_URL");
  const hostname = new URL(supabaseUrl).hostname.toLowerCase();
  if (/(^|[-.])prod(uction)?([-.]|$)/i.test(supabaseUrl) || hostname.includes("production")) {
    throw new Error("Refusing production-looking Supabase URL.");
  }
  if (supabaseUrl.includes(blockedProductionRef) || hostname.includes(blockedProductionRef)) {
    throw new Error("Refusing Phoenix HR production project.");
  }
  const approvedRef = approvedStagingRef();
  if (hostname !== `${approvedRef}.supabase.co`) {
    throw new Error("Refusing any Supabase URL except the approved Phoenix RLS testing sandbox.");
  }

  requiredEnv("PHOENIX_STAGING_SUPABASE_ANON_KEY");
  const databaseUrl = requiredEnv("PHOENIX_STAGING_DATABASE_URL");
  const databaseHostname = new URL(databaseUrl).hostname.toLowerCase();
  if (databaseUrl.includes(blockedProductionRef) || databaseHostname.includes(blockedProductionRef)) {
    throw new Error("Refusing Phoenix HR production database URL.");
  }
  const isApprovedDirectHost = databaseHostname === `db.${approvedRef}.supabase.co`;
  const isApprovedPoolerHost =
    databaseHostname.endsWith(".pooler.supabase.com") && databaseUrl.includes(`postgres.${approvedRef}`);
  if (!isApprovedDirectHost && !isApprovedPoolerHost) {
    throw new Error("Refusing database URL that does not target the approved Phoenix RLS testing sandbox.");
  }
  requiredEnv("PHOENIX_RLS_ADMIN_LOGIN_ID");
  requiredEnv("PHOENIX_RLS_ADMIN_PASSWORD");

  return { hostname };
}

function buildPhoenixAuthEmail(loginId: string) {
  const encodedLoginId = Buffer.from(loginId.trim().toLowerCase()).toString("hex");
  return `phx-${encodedLoginId}@auth.phoenix.local`;
}

function mapPhoenixRoleToCoarseAccessRole(role: PhoenixRole) {
  switch (role) {
    case "Super Admin":
      return "super_admin";
    case "CEO":
    case "SFE Manager":
      return "company_reader";
    case "Finance Manager":
      return "finance";
    case "Talent Acquisition":
      return "hr";
    case "District Manager":
    case "Regional Manager":
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "Training Manager":
    case "Marketing Manager":
    case "Manager":
      return "manager";
    default:
      return "employee";
  }
}

function mapPhoenixRoleToLegacyBootstrapRole(role: PhoenixRole) {
  switch (role) {
    case "Super Admin":
    case "CEO":
    case "Finance Manager":
      return "admin";
    case "Talent Acquisition":
      return "hr";
    case "District Manager":
    case "Regional Manager":
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "SFE Manager":
    case "Training Manager":
    case "Marketing Manager":
    case "Manager":
      return "manager";
    default:
      return "employee";
  }
}

function mapPhoenixRoleToScopeType(role: PhoenixRole) {
  switch (role) {
    case "Super Admin":
      return "SUPER_ADMIN";
    case "CEO":
    case "SFE Manager":
      return "COMPANY_READ";
    case "Finance Manager":
      return "FINANCE";
    case "Talent Acquisition":
      return "HR";
    case "District Manager":
    case "Manager":
      return "TEAM";
    case "Regional Manager":
      return "HIERARCHY";
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "Training Manager":
    case "Marketing Manager":
      return "LINE";
    default:
      return "SELF";
  }
}

function createAdminSql() {
  return postgres(requiredEnv("PHOENIX_STAGING_DATABASE_URL"), {
    idle_timeout: 20,
    max: 1,
    ssl: "require",
  });
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

async function verifyAdminLoginIfPossible() {
  const client = createClient(
    requiredEnv("PHOENIX_STAGING_SUPABASE_URL"),
    requiredEnv("PHOENIX_STAGING_SUPABASE_ANON_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    },
  );

  const { error } = await client.auth.signInWithPassword({
    email: buildPhoenixAuthEmail(requiredEnv("PHOENIX_RLS_ADMIN_LOGIN_ID")),
    password: requiredEnv("PHOENIX_RLS_ADMIN_PASSWORD"),
  });
  await client.auth.signOut();
  return error ? `Supabase Auth login unavailable: ${error.message}` : "Supabase Auth login succeeded";
}

async function verifyAdminMetadata(sql: postgres.Sql) {
  const rows = await sql<{ is_active: boolean; login_id: string; role: string }[]>`
    select login_id, role, is_active
    from public.app_auth_users
    where lower(login_id) = lower(${requiredEnv("PHOENIX_RLS_ADMIN_LOGIN_ID")})
    limit 1
  `;
  const admin = rows[0];
  if (!admin) throw new Error("Admin login was not found in app_auth_users.");
  if (!admin.is_active) throw new Error("Admin login exists but is inactive.");
  if (admin.role !== "Super Admin" && admin.role !== "Admin" && admin.role !== "Account Admin") {
    throw new Error(`Admin login role is ${admin.role}; expected Super Admin or equivalent staging setup role.`);
  }
  return admin;
}

function existingUsersFromEnv() {
  const raw = process.env.PHOENIX_RLS_TEST_USERS_JSON?.trim();
  if (!raw) return {} as Partial<Record<PhoenixRole, TestUser>>;
  return JSON.parse(raw) as Partial<Record<PhoenixRole, TestUser>>;
}

function generatePassword() {
  return `${randomBytes(24).toString("base64url")}aA1!`;
}

async function upsertEnvValue(path: string, key: string, value: string) {
  const existing = existsSync(path) ? await readFile(path, "utf8") : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(existing)
    ? existing.replace(pattern, line)
    : `${existing.trimEnd()}\n${line}\n`;
  await writeFile(path, next);
}

function buildName(role: PhoenixRole) {
  return `PHX RLS Staging Test ${role}`;
}

async function ensureLookupId(sql: postgres.Sql, tableName: "lines", value: string) {
  const rows = await sql<{ id: number }[]>`
    select id
    from public.lines
    where lower(name) = lower(${value})
    limit 1
  `;
  if (rows[0]) return rows[0].id;
  const inserted = await sql<{ id: number }[]>`
    insert into public.lines (name, code)
    values (${value}, ${`RLS-${value.toUpperCase().replace(/[^A-Z0-9]/g, "")}`})
    on conflict (name) do update set updated_at = now()
    returning id
  `;
  return inserted[0].id;
}

async function createOrUpdateTestUser(
  sql: postgres.Sql,
  spec: RoleSpec,
  password: string,
  columns: {
    appAuthUsers: Set<string>;
    authIdentities: Set<string>;
    authUsers: Set<string>;
    employees: Set<string>;
    userAccessProfiles: Set<string>;
  },
) {
  requireColumns("employees", columns.employees, ["hr_id", "full_name", "employment_status", "manager_hr_id", "line_id"]);
  requireColumns("app_auth_users", columns.appAuthUsers, ["login_id", "password_hash", "role", "hr_id", "is_active"]);
  requireColumns("auth.users", columns.authUsers, ["id", "email", "encrypted_password", "raw_app_meta_data", "raw_user_meta_data"]);
  requireColumns("auth.identities", columns.authIdentities, ["provider_id", "user_id", "identity_data", "provider"]);
  requireColumns("user_access_profiles", columns.userAccessProfiles, ["auth_user_id", "hr_id", "role", "is_active", "login_id", "phoenix_role"]);

  const lineId = await ensureLookupId(sql, "lines", spec.line);
  const employeeExisting = await sql<{ hr_id: string }[]>`
    select hr_id
    from public.employees
    where lower(hr_id) = lower(${spec.hrId})
    limit 1
  `;
  const employeePayload: Record<string, unknown> = {
    employment_status: "active",
    full_name: buildName(spec.role),
    job_title: spec.role,
    line_id: lineId,
    manager_hr_id: spec.managerHrId,
    updated_at: new Date(),
  };
  if (columns.employees.has("is_rls_staging_test")) employeePayload.is_rls_staging_test = true;
  if (columns.employees.has("notes")) employeePayload.notes = "PHX_RLS_STAGING_TEST";
  if (columns.employees.has("comment")) employeePayload.comment = "PHX_RLS_STAGING_TEST";

  if (employeeExisting.length) {
    await sql`update public.employees set ${sql(employeePayload)} where lower(hr_id) = lower(${spec.hrId})`;
  } else {
    await sql`insert into public.employees ${sql({ ...employeePayload, hr_id: spec.hrId })}`;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const authEmail = buildPhoenixAuthEmail(spec.loginId);
  const existingAuth = await sql<{ auth_user_id: string | null }[]>`
    select auth_user_id
    from public.app_auth_users
    where lower(login_id) = lower(${spec.loginId})
    limit 1
  `;
  const authUserId = existingAuth[0]?.auth_user_id ?? randomUUID();

  const appUserPayload: Record<string, unknown> = {
    auth_email: authEmail,
    auth_user_id: authUserId,
    force_password_reset: false,
    hr_id: spec.hrId,
    is_active: true,
    line: spec.line,
    login_id: spec.loginId,
    manager_hr_id: spec.managerHrId,
    name: buildName(spec.role),
    password_hash: passwordHash,
    role: spec.role,
    session_version: 1,
    updated_at: new Date(),
  };
  const filteredAppUserPayload = Object.fromEntries(
    Object.entries(appUserPayload).filter(([key]) => columns.appAuthUsers.has(key)),
  );

  const appMeta = {
    access_scope: mapPhoenixRoleToScopeType(spec.role),
    coarse_access_role: mapPhoenixRoleToCoarseAccessRole(spec.role),
    hr_id: spec.hrId,
    is_active: true,
    line: spec.line,
    login_id: spec.loginId,
    phoenix_role: spec.role,
    provider: "email",
    providers: ["email"],
  };
  const userMeta = {
    hr_id: spec.hrId,
    line: spec.line,
    login_id: spec.loginId,
    manager_hr_id: spec.managerHrId,
    name: buildName(spec.role),
    phoenix_role: spec.role,
  };

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
      crypt(${password}, gen_salt('bf')),
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
    on conflict (id) do update set
      instance_id = excluded.instance_id,
      email = excluded.email,
      encrypted_password = excluded.encrypted_password,
      email_confirmed_at = coalesce(auth.users.email_confirmed_at, now()),
      confirmation_token = '',
      recovery_token = '',
      email_change_token_new = '',
      email_change = '',
      raw_app_meta_data = excluded.raw_app_meta_data,
      raw_user_meta_data = excluded.raw_user_meta_data,
      updated_at = now()
  `;

  await sql`
    delete from auth.identities
    where provider = 'email'
      and user_id = ${authUserId}
  `;

  const identityPayload: Record<string, unknown> = {
    provider_id: authEmail,
    user_id: authUserId,
    identity_data: { email: authEmail, email_verified: true, sub: authUserId },
    provider: "email",
    last_sign_in_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const filteredIdentityPayload = Object.fromEntries(
    Object.entries(identityPayload).filter(([key]) => columns.authIdentities.has(key)),
  );
  const filteredIdentityUpdatePayload = Object.fromEntries(
    Object.entries({
      user_id: authUserId,
      identity_data: identityPayload.identity_data,
      updated_at: new Date(),
    }).filter(([key]) => columns.authIdentities.has(key)),
  );

  await sql`
    insert into auth.identities ${sql(filteredIdentityPayload)}
    on conflict (provider, provider_id) do update set ${sql(filteredIdentityUpdatePayload)}
  `;

  await sql`
    insert into public.app_auth_users ${sql({ ...filteredAppUserPayload, created_at: new Date() })}
    on conflict (login_id) do update set ${sql(filteredAppUserPayload)}
  `;

  const profilePayload: Record<string, unknown> = {
    auth_user_id: authUserId,
    hr_id: spec.hrId,
    is_active: true,
    line: spec.line,
    login_id: spec.loginId,
    manager_hr_id: spec.managerHrId,
    phoenix_role: spec.role,
    role: mapPhoenixRoleToLegacyBootstrapRole(spec.role),
    scope_type: mapPhoenixRoleToScopeType(spec.role),
    updated_at: new Date(),
  };
  const filteredProfilePayload = Object.fromEntries(
    Object.entries(profilePayload).filter(([key]) => columns.userAccessProfiles.has(key)),
  );

  await sql`
    insert into public.user_access_profiles ${sql({ ...filteredProfilePayload, created_at: new Date() })}
    on conflict (auth_user_id) do update set ${sql(filteredProfilePayload)}
  `;
}

async function inspectCoverage(sql: postgres.Sql) {
  const rows = await sql<{ auth_user_id: string | null; hr_id: string | null; is_active: boolean; login_id: string; phoenix_role: string | null; role: string }[]>`
    select login_id, hr_id, role, auth_user_id, is_active, role as phoenix_role
    from public.app_auth_users
    where role in ${sql(roles)}
      and coalesce(is_active, false) = true
  `;
  return rows;
}

function chooseUserForRole(
  role: PhoenixRole,
  coverageRows: Awaited<ReturnType<typeof inspectCoverage>>,
  envUsers: Partial<Record<PhoenixRole, TestUser>>,
) {
  const envUser = envUsers[role];
  if (envUser?.loginId && envUser.password && envUser.hrId) return envUser;

  const spec = roleSpecs[role];
  const deterministic = coverageRows.find((row) => row.login_id === spec.loginId && row.hr_id === spec.hrId);
  if (deterministic) {
    const token = role.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const password = process.env[`PHOENIX_RLS_${token}_PASSWORD`];
    if (password) {
      return { hrId: spec.hrId, loginId: spec.loginId, password };
    }
  }

  return null;
}

async function main() {
  const loadInfo = loadLocalEnvFile(localEnvPath);
  console.log(
    loadInfo.status === "found"
      ? `PASS loaded ${localEnvPath} (${loadInfo.loadedKeys} keys, secrets not printed)`
      : `PASS ${localEnvPath} not found; using process environment only`,
  );

  const { hostname } = assertStagingSafety();
  console.log(`PASS staging safety gates (${hostname})`);

  let sql: postgres.Sql | null = null;
  try {
    sql = createAdminSql();

    const authLoginStatus = await verifyAdminLoginIfPossible();
    console.log(`PASS admin login check completed (${authLoginStatus})`);
    const admin = await verifyAdminMetadata(sql);
    console.log(`PASS admin metadata verified (${admin.login_id}, role=${admin.role})`);

    const columns = {
      appAuthUsers: await tableColumns(sql, "app_auth_users"),
      authIdentities: await tableColumns(sql, "identities", "auth"),
      authUsers: await tableColumns(sql, "users", "auth"),
      employees: await tableColumns(sql, "employees"),
      userAccessProfiles: await tableColumns(sql, "user_access_profiles"),
    };
    console.log("PASS inspected staging auth/RLS tables");

    let envUsers = existingUsersFromEnv();
    let coverageRows = await inspectCoverage(sql);
    const missingRolesBeforeCreate = roles.filter((role) => !chooseUserForRole(role, coverageRows, envUsers));
    const autoCreate = process.env.PHOENIX_RLS_AUTO_CREATE_TEST_USERS === "1";

    if (missingRolesBeforeCreate.length && !autoCreate) {
      console.log(`FAIL missing role passwords/users: ${missingRolesBeforeCreate.join(", ")}`);
      console.log("Set PHOENIX_RLS_AUTO_CREATE_TEST_USERS=1 for staging-only auto creation, or provide passwords in PHOENIX_RLS_TEST_USERS_JSON.");
      process.exitCode = 1;
      return;
    }

    const finalUsers: Record<PhoenixRole, TestUser> = {} as Record<PhoenixRole, TestUser>;
    let autoCreated = false;
    if (autoCreate) {
      for (const role of testUserCreationOrder) {
        const existing = chooseUserForRole(role, coverageRows, envUsers);
        const password = existing?.password ?? generatePassword();
        await createOrUpdateTestUser(sql, roleSpecs[role], password, columns);
        finalUsers[role] = {
          hrId: roleSpecs[role].hrId,
          loginId: roleSpecs[role].loginId,
          password,
        };
        if (!existing) autoCreated = true;
      }
      coverageRows = await inspectCoverage(sql);
      envUsers = finalUsers;
    } else {
      for (const role of roles) {
        const user = chooseUserForRole(role, coverageRows, envUsers);
        if (!user) throw new Error(`Missing user for ${role}`);
        finalUsers[role] = user;
      }
    }

    const coverage = roles.map((role) => {
      const user = finalUsers[role];
      const row = coverageRows.find((item) => item.login_id === user.loginId || item.hr_id === user.hrId);
      return {
        active: Boolean(row?.is_active),
        authLinked: Boolean(row?.auth_user_id),
        hrId: user.hrId,
        loginId: user.loginId,
        role,
      };
    });

    await upsertEnvValue(localEnvPath, "PHOENIX_RLS_TEST_USERS_JSON", JSON.stringify(finalUsers));
    console.log("PASS wrote PHOENIX_RLS_TEST_USERS_JSON to .env.staging.rls.local (passwords not printed)");
    console.log(`PASS auto-created staging users: ${autoCreated ? "yes" : "no"}`);
    console.log("Role coverage report:");
    for (const row of coverage) {
      console.log(`- ${row.role}: loginId=${row.loginId}; hrId=${row.hrId}; active=${row.active}; authLinked=${row.authLinked}`);
    }
  } finally {
    if (sql) await sql.end({ timeout: 5 });
  }
}

await main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
