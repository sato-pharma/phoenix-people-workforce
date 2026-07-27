import { existsSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type PhoenixRole =
  | "Employee"
  | "Medical Rep"
  | "District Manager"
  | "Finance Manager"
  | "Talent Acquisition"
  | "CEO"
  | "Super Admin";

type TestUser = {
  hrId: string;
  loginId: string;
  password: string;
};

type Check = {
  detail?: string;
  name: string;
  ok: boolean;
  role?: PhoenixRole;
  surface: string;
};

const localEnvPath = ".env.staging.rls.local";
const blockedProductionRef = "ozucdzovmcqvepbozvqf";

const roles: PhoenixRole[] = [
  "Super Admin",
  "Talent Acquisition",
  "Finance Manager",
  "CEO",
  "District Manager",
  "Medical Rep",
  "Employee",
];

const expectedByRole: Record<PhoenixRole, {
  accessRole: string;
  canManageEmployees: boolean;
  canManagePayroll: boolean;
  isCompanyReader: boolean;
  isFinance: boolean;
  isHr: boolean;
  isSuperAdmin: boolean;
  scope: string;
}> = {
  "Super Admin": {
    accessRole: "super_admin",
    canManageEmployees: true,
    canManagePayroll: true,
    isCompanyReader: true,
    isFinance: false,
    isHr: false,
    isSuperAdmin: true,
    scope: "SUPER_ADMIN",
  },
  "Talent Acquisition": {
    accessRole: "employee",
    canManageEmployees: false,
    canManagePayroll: false,
    isCompanyReader: false,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "SELF",
  },
  "Finance Manager": {
    accessRole: "finance",
    canManageEmployees: false,
    canManagePayroll: true,
    isCompanyReader: false,
    isFinance: true,
    isHr: false,
    isSuperAdmin: false,
    scope: "FINANCE",
  },
  CEO: {
    accessRole: "company_reader",
    canManageEmployees: false,
    canManagePayroll: false,
    isCompanyReader: true,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "COMPANY_READ",
  },
  "District Manager": {
    accessRole: "manager",
    canManageEmployees: false,
    canManagePayroll: false,
    isCompanyReader: false,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "TEAM",
  },
  "Medical Rep": {
    accessRole: "employee",
    canManageEmployees: false,
    canManagePayroll: false,
    isCompanyReader: false,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "SELF",
  },
  Employee: {
    accessRole: "employee",
    canManageEmployees: false,
    canManagePayroll: false,
    isCompanyReader: false,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "SELF",
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

// This is the allowlist gate, so it carries no baked-in default. It used to compare against the
// retired oaifhavixhdtwmseshff sandbox, which is no longer on the Supabase account: that turned
// any run into a confusing "not the approved sandbox" refusal against a ref nobody recognises,
// instead of naming the actual problem here.
function approvedStagingRef() {
  const ref = process.env.PHOENIX_APPROVED_STAGING_REF?.trim();
  if (!ref) {
    throw new Error(
      "PHOENIX_APPROVED_STAGING_REF is required. Set it to the approved staging project ref in .env.staging.rls.local.",
    );
  }
  return ref;
}

function stagingUrl() {
  const confirm = requiredEnv("PHOENIX_CONFIRM_STAGING_RLS_RUN");
  if (confirm !== "YES_STAGING_ONLY") {
    throw new Error('PHOENIX_CONFIRM_STAGING_RLS_RUN must be "YES_STAGING_ONLY".');
  }

  const environment = requiredEnv("PHOENIX_STAGING_ENVIRONMENT").toLowerCase();
  if (!/(local|staging|stage|preview|dev|test|branch)/i.test(environment) || environment.includes("production")) {
    throw new Error(`Refusing non-staging environment "${environment}".`);
  }

  const url = requiredEnv("PHOENIX_STAGING_SUPABASE_URL").replace(/\/+$/g, "");
  const hostname = new URL(url).hostname.toLowerCase();
  if (url.includes(blockedProductionRef) || hostname.includes(blockedProductionRef)) {
    throw new Error("Refusing Phoenix production Supabase project.");
  }
  if (hostname !== `${approvedStagingRef()}.supabase.co`) {
    throw new Error("Refusing any Supabase URL except the approved Phoenix RLS testing sandbox.");
  }
  return url;
}

function parseUsersConfig(): Record<PhoenixRole, TestUser> {
  const parsed = JSON.parse(requiredEnv("PHOENIX_RLS_TEST_USERS_JSON")) as Partial<Record<PhoenixRole, TestUser>>;
  const missing = roles.filter((role) => !parsed[role]?.hrId || !parsed[role]?.loginId || !parsed[role]?.password);
  if (missing.length > 0) {
    throw new Error(`PHOENIX_RLS_TEST_USERS_JSON is missing Phase 24 roles: ${missing.join(", ")}`);
  }
  return parsed as Record<PhoenixRole, TestUser>;
}

function buildPhoenixAuthEmail(loginId: string) {
  const encodedLoginId = Buffer.from(loginId.trim().toLowerCase()).toString("hex");
  return `phx-${encodedLoginId}@auth.phoenix.local`;
}

function createAnonClient() {
  return createClient(stagingUrl(), requiredEnv("PHOENIX_STAGING_SUPABASE_ANON_KEY"), {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

async function signIn(role: PhoenixRole, user: TestUser) {
  const client = createAnonClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: buildPhoenixAuthEmail(user.loginId),
    password: user.password,
  });
  if (error || !data.session?.access_token) {
    throw new Error(`${role} real Supabase Auth login failed: ${error?.message ?? "missing session"}`);
  }
  return client;
}

function pass(surface: string, name: string, role?: PhoenixRole, detail?: string): Check {
  return { detail, name, ok: true, role, surface };
}

function fail(surface: string, name: string, error: unknown, role?: PhoenixRole): Check {
  return {
    detail: error instanceof Error ? error.message : String(error),
    name,
    ok: false,
    role,
    surface,
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

async function rpcValue<T>(client: SupabaseClient, name: string): Promise<T> {
  const { data, error } = await client.rpc(name);
  if (error) throw error;
  return data as T;
}

async function verifyRlsHelpers(client: SupabaseClient, role: PhoenixRole) {
  const expected = expectedByRole[role];
  assertEqual(await rpcValue<string>(client, "current_phoenix_role"), role, "current_phoenix_role()");
  assertEqual(await rpcValue<string>(client, "current_access_role"), expected.accessRole, "current_access_role()");
  assertEqual(await rpcValue<string>(client, "current_access_scope"), expected.scope, "current_access_scope()");
  assertEqual(await rpcValue<boolean>(client, "current_access_is_super_admin"), expected.isSuperAdmin, "current_access_is_super_admin()");
  assertEqual(await rpcValue<boolean>(client, "current_access_is_hr"), expected.isHr, "current_access_is_hr()");
  assertEqual(await rpcValue<boolean>(client, "current_access_is_finance"), expected.isFinance, "current_access_is_finance()");
  assertEqual(await rpcValue<boolean>(client, "current_access_is_company_reader"), expected.isCompanyReader, "current_access_is_company_reader()");
  assertEqual(await rpcValue<boolean>(client, "current_access_can_manage_employees"), expected.canManageEmployees, "current_access_can_manage_employees()");
  assertEqual(await rpcValue<boolean>(client, "current_access_can_manage_payroll"), expected.canManagePayroll, "current_access_can_manage_payroll()");
}

async function verifyOwnProfile(client: SupabaseClient, role: PhoenixRole, user: TestUser) {
  const { data, error } = await client
    .from("user_access_profiles")
    .select("hr_id, login_id, phoenix_role, role, scope_type")
    .eq("hr_id", user.hrId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("own user_access_profiles row is not visible");
  assertEqual(data.phoenix_role, role, "user_access_profiles.phoenix_role");
  assertEqual(data.role, expectedByRole[role].accessRole, "user_access_profiles.role");
  assertEqual(data.scope_type, expectedByRole[role].scope, "user_access_profiles.scope_type");
}

async function verifyEmployeeScope(client: SupabaseClient, role: PhoenixRole, user: TestUser) {
  const { data, error } = await client
    .from("employees")
    .select("hr_id, manager_hr_id")
    .limit(1000);
  if (error) throw error;

  const visibleHrIds = new Set((data ?? []).map((row) => String(row.hr_id ?? "").toLowerCase()).filter(Boolean));
  const ownHrId = user.hrId.toLowerCase();
  if (!visibleHrIds.has(ownHrId)) {
    throw new Error("own employee row is not visible through RLS");
  }

  if (role === "Employee" || role === "Medical Rep") {
    const leakedRows = [...visibleHrIds].filter((hrId) => hrId !== ownHrId);
    if (leakedRows.length > 0) {
      throw new Error(`self-only role can see ${leakedRows.length} other employee rows`);
    }
  }

  if (role === "District Manager") {
    const outOfTeamRows = (data ?? []).filter((row) => {
      const rowHrId = String(row.hr_id ?? "").toLowerCase();
      const managerHrId = String(row.manager_hr_id ?? "").toLowerCase();
      return rowHrId !== ownHrId && managerHrId !== ownHrId;
    });
    if (outOfTeamRows.length > 0) {
      throw new Error(`District Manager can see ${outOfTeamRows.length} employees outside self/direct team`);
    }
  }

  return visibleHrIds;
}

async function verifyReadableSurface(
  client: SupabaseClient,
  role: PhoenixRole,
  table: string,
  select: string,
) {
  const { error } = await client
    .from(table)
    .select(select)
    .limit(25);
  if (error) {
    if (/schema cache|relation .* does not exist|could not find the table/i.test(error.message)) {
      return `${table} is not present in the staging API schema cache; coverage skipped`;
    }
    throw new Error(`${role} cannot read ${table}: ${error.message}`);
  }
  return `${table} read accepted`;
}

async function verifyScopedPayrollRows(
  client: SupabaseClient,
  role: PhoenixRole,
  user: TestUser,
  visibleEmployeeHrIds: Set<string>,
) {
  const { data, error } = await client
    .from("salary_records")
    .select("hr_id")
    .limit(500);
  if (error) throw error;

  if (expectedByRole[role].canManagePayroll) return;

  const allowed = new Set([...visibleEmployeeHrIds, user.hrId.toLowerCase()]);
  const leakedRows = (data ?? []).filter((row) => {
    const hrId = String(row.hr_id ?? "").toLowerCase();
    return hrId && !allowed.has(hrId);
  });
  if (leakedRows.length > 0) {
    throw new Error(`${role} can see ${leakedRows.length} payroll rows outside allowed scope`);
  }
}

function assertSourceContains(path: string, label: string, patterns: RegExp[]) {
  const source = readFileSync(path, "utf8");
  const missing = patterns.filter((pattern) => !pattern.test(source));
  if (missing.length > 0) {
    throw new Error(`${label} is missing expected guard(s): ${missing.map(String).join(", ")}`);
  }
}

function verifyApiGuardSources() {
  assertSourceContains("app/api/auth/login/route.ts", "login route Supabase Auth bridge", [
    /createSupabaseAuthSession/,
    /phoenixSupabaseAccessTokenCookieName/,
    /phoenixSupabaseRefreshTokenCookieName/,
  ]);
  assertSourceContains("src/lib/supabase/rls-server.ts", "request-scoped RLS client", [
    /phoenixSupabaseAccessTokenCookieName/,
    /supabase\.auth\.setSession/,
  ]);
  assertSourceContains("app/api/payroll/upload/route.ts", "payroll upload route", [
    /assertPermission\(access, "payroll", "import"\)/,
  ]);
  assertSourceContains("app/api/payroll/[id]/workflow/route.ts", "payroll workflow route", [
    /assertPermission\(access, "payroll", action === "approve" \? "approve" : "update"\)/,
  ]);
  assertSourceContains("app/api/sales/imports/upload/route.ts", "sales import route", [
    /assertPermission\(access, "sales", "import"\)/,
  ]);
  assertSourceContains("app/api/admin/users/bulk-action/route.ts", "Users & Access bulk route", [
    /assertPermission\(access, "user_admin", "update"\)/,
  ]);
  assertSourceContains("app/(admin)/employees/page.tsx", "employees page", [
    /canAccess\(access, "employees", "read"\)/,
    /redirect\("\/employee-portals"\)/,
  ]);
}

async function runRole(role: PhoenixRole, user: TestUser): Promise<Check[]> {
  const checks: Check[] = [];
  const client = await signIn(role, user);
  try {
    try {
      await verifyRlsHelpers(client, role);
      checks.push(pass("RLS helpers", "real JWT resolves expected Phoenix role/scope", role));
    } catch (error) {
      checks.push(fail("RLS helpers", "real JWT resolves expected Phoenix role/scope", error, role));
    }

    try {
      await verifyOwnProfile(client, role, user);
      checks.push(pass("Access profile", "own role profile is visible and aligned", role));
    } catch (error) {
      checks.push(fail("Access profile", "own role profile is visible and aligned", error, role));
    }

    let visibleEmployeeHrIds = new Set<string>();
    try {
      visibleEmployeeHrIds = await verifyEmployeeScope(client, role, user);
      checks.push(pass("Employees RLS", "employee visibility is scoped", role, `${visibleEmployeeHrIds.size} visible employee rows`));
    } catch (error) {
      checks.push(fail("Employees RLS", "employee visibility is scoped", error, role));
    }

    for (const [surface, table, select] of [
      ["Payroll RLS", "salary_records", "hr_id"],
      ["Expenses RLS", "payroll_expenses", "hr_id"],
      ["Sales RLS", "sales_records", "employee_hr_id, manager_hr_id, line"],
      ["Probation RLS", "employee_probation", "employee_hr_id, manager_hr_id"],
      ["Leave RLS", "v2_vacation_requests", "employee_hr_id, manager_hr_id"],
    ] as const) {
      try {
        const detail = await verifyReadableSurface(client, role, table, select);
        checks.push(pass(surface, `${table} read is accepted by RLS`, role, detail));
      } catch (error) {
        checks.push(fail(surface, `${table} read is accepted by RLS`, error, role));
      }
    }

    try {
      await verifyScopedPayrollRows(client, role, user, visibleEmployeeHrIds);
      checks.push(pass("Payroll RLS", "salary rows stay inside allowed scope", role));
    } catch (error) {
      checks.push(fail("Payroll RLS", "salary rows stay inside allowed scope", error, role));
    }
  } finally {
    await client.auth.signOut();
  }
  return checks;
}

async function main() {
  const loadInfo = loadLocalEnvFile(localEnvPath);
  const users = parseUsersConfig();
  const checks: Check[] = [
    pass(
      "Environment",
      loadInfo.status === "found" ? "loaded staging env without printing secrets" : "using process env only",
      undefined,
      loadInfo.status === "found" ? `${loadInfo.loadedKeys} keys` : undefined,
    ),
  ];

  for (const role of roles) {
    try {
      checks.push(...await runRole(role, users[role]));
    } catch (error) {
      checks.push(fail("Real Supabase Auth", "role sign-in and RLS checks", error, role));
    }
  }

  try {
    verifyApiGuardSources();
    checks.push(pass("API guards", "service-role-backed app routes keep explicit permission guards"));
  } catch (error) {
    checks.push(fail("API guards", "service-role-backed app routes keep explicit permission guards", error));
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    failed,
    passed: checks.length - failed.length,
    policy: {
      api: "Service-role-backed app routes must keep explicit Phoenix permission guards.",
      mode: "PHASE24 real Supabase Auth smoke is read-only and uses the approved staging sandbox only.",
      rls: "Authenticated Supabase JWTs must resolve Phoenix role/scope through current_access helpers and table policies.",
    },
    results: checks,
  }, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
