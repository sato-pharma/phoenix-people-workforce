import { existsSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type PhoenixRole =
  | "Employee"
  | "Medical Rep"
  | "District Manager"
  | "Finance Manager"
  | "HR Advisory"
  | "HR Operations"
  | "CEO"
  | "Super Admin";

type TestUser = {
  hrId: string;
  loginId: string;
  password: string;
};

// "skipped" exists so a check that could not run can never be counted as a green one. It is a
// distinct third state on purpose: "RLS refused me" (fail) and "the table this check names is not
// there any more" (skipped) are different defects and want different fixes, but neither is a pass.
type CheckStatus = "pass" | "fail" | "skipped";

type Check = {
  detail?: string;
  name: string;
  role?: PhoenixRole;
  status: CheckStatus;
  surface: string;
};

const localEnvPath = ".env.staging.rls.local";
const blockedProductionRef = "ozucdzovmcqvepbozvqf";

const roles: PhoenixRole[] = [
  "Super Admin",
  "HR Advisory",
  "HR Operations",
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
  // The two HR seats, IDENTICAL here except for `scope`. The application-layer split gives HR
  // Advisory recruiting and HR Operations personnel records, and neither is a legacy DB role, so
  // canManageEmployees stays FALSE even for the seat that maintains employee records - that
  // authority is application-scoped, enforced by assertPermission, and never by RLS. Asserting both
  // is what catches someone "fixing" that.
  //
  // `scope` diverged on 2026-08-29 (#2619, owner's ruling that HR Operations carries company
  // scope). It is the ONE field that moved, and the reason it moves alone is worth keeping: this
  // block's other six fields are answered by role-based functions, not scope-based ones -
  // current_access_can_manage_employees() is `role = 'Super Admin'`,
  // current_access_can_manage_payroll() is `role in ('Finance Manager','Super Admin')`,
  // current_access_is_company_reader() is `role in ('CEO','SFE Manager','Super Admin')`, and
  // current_access_is_hr() is hard-wired `select false`. Only private.phx_current_scope() /
  // current_access_scope() read user_access_profiles.scope_type, and NO RLS policy calls either
  // (measured on production 2026-08-29: 402 policies, 0 referencing current_access_scope). So her
  // DB-layer scope moving to COMPANY_READ widened nothing - if a future field here starts tracking
  // the scope instead of the role, that is the change to look at twice.
  //
  // This expectation is read back from the DATABASE, so the production row has to agree with it:
  // user_access_profiles.scope_type is written at provisioning by
  // mapPhoenixRoleToAccessScopeType, and HR-009's row was re-stamped to COMPANY_READ on
  // 2026-08-29. A seat provisioned before that date keeps whatever it was given.
  "HR Advisory": {
    accessRole: "employee",
    canManageEmployees: false,
    canManagePayroll: false,
    isCompanyReader: false,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "SELF",
  },
  "HR Operations": {
    accessRole: "employee",
    canManageEmployees: false,
    canManagePayroll: false,
    isCompanyReader: false,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "COMPANY_READ",
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
  return { detail, name, role, status: "pass", surface };
}

function fail(surface: string, name: string, error: unknown, role?: PhoenixRole): Check {
  return {
    detail: error instanceof Error ? error.message : String(error),
    name,
    role,
    status: "fail",
    surface,
  };
}

function skip(surface: string, name: string, error: unknown, role?: PhoenixRole): Check {
  return {
    detail: error instanceof Error ? error.message : String(error),
    name,
    role,
    status: "skipped",
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

// Reads every row RLS lets this role see. A single `.limit(n)` would stop silently at n, and the
// "no other employee is visible" checks below must look at all of them. `orderColumn` must be unique.
async function readAllRows(client: SupabaseClient, table: string, select: string, orderColumn: string) {
  const pageSize = 1000;
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from(table)
      .select(select)
      .order(orderColumn, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
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
  const data = await readAllRows(client, "employees", "hr_id, manager_hr_id", "hr_id");

  const visibleHrIds = new Set(data.map((row) => String(row.hr_id ?? "").toLowerCase()).filter(Boolean));
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
    const outOfTeamRows = data.filter((row) => {
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

// Thrown when the named table is not reachable through the API at all, so the check never got as
// far as exercising a policy. Distinct from a plain Error, which here means RLS actively refused a
// read that should have been allowed.
class SurfaceUnavailableError extends Error {}

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
    // This branch used to `return` a human-readable excuse string, which the caller then recorded
    // with pass(). That is how "Expenses RLS - payroll_expenses read is accepted by RLS" stayed green for
    // a month after 20260713120000_rename_payroll_expenses_to_outstation.sql removed that table:
    // every role reported a pass for a read that never touched a policy. A check that cannot run is
    // now surfaced as "skipped" and fails the run, so a renamed table is loud instead of invisible.
    const code = (error as { code?: string }).code ?? "";
    if (
      code === "PGRST205" ||
      code === "42P01" ||
      /schema cache|relation .* does not exist|could not find the table/i.test(error.message)
    ) {
      throw new SurfaceUnavailableError(
        `${table} is not reachable through the staging API (${code || "no code"}: ${error.message}). ` +
          "The check named a table that is not there, so no RLS policy was exercised — fix the table name in this smoke.",
      );
    }
    throw new Error(`${role} cannot read ${table}: ${error.message}`);
  }
  return `${table} read accepted`;
}

// The inverse of verifyReadableSurface: for a surface that must stay service-role only, a clean
// read is the failure and 42501 is the pass. Table-not-there still routes to SurfaceUnavailableError
// so a rename or drop is loud here too, and a denial for any OTHER reason (e.g. network, auth) does
// not get credited as proof of the lockdown.
async function verifyDeniedSurface(client: SupabaseClient, table: string) {
  const { error } = await client
    .from(table)
    .select("*")
    .limit(1);
  if (!error) {
    throw new Error(`${table} is readable by authenticated — this table is meant to stay service-role only`);
  }
  const code = (error as { code?: string }).code ?? "";
  if (
    code === "PGRST205" ||
    code === "42P01" ||
    /schema cache|relation .* does not exist|could not find the table/i.test(error.message)
  ) {
    throw new SurfaceUnavailableError(
      `${table} is not reachable through the staging API (${code || "no code"}: ${error.message}). ` +
        "The check named a table that is not there — fix the table name in this smoke.",
    );
  }
  if (code !== "42501") {
    throw new Error(
      `${table} denied authenticated for an unexpected reason (${code || "no code"}: ${error.message}), ` +
        "not the expected 42501 — confirm RLS is still enabled before trusting this check.",
    );
  }
  return `${table} correctly denies authenticated reads (42501)`;
}

async function verifyScopedPayrollRows(
  client: SupabaseClient,
  role: PhoenixRole,
  user: TestUser,
  visibleEmployeeHrIds: Set<string>,
) {
  const data = await readAllRows(client, "salary_records", "hr_id", "id");

  // salary_records_select_access grants full, unconditional visibility through two disjuncts:
  // phx_can_manage_payroll() OR phx_has_company_access() (verified against pg_policy in both
  // staging and production, 2026-08-13). A company-reader role's scope IS "every row" by design, so
  // testing containment against "currently-live employees" is the wrong test for that role — it can
  // never legitimately fail, and a row for a resigned employee whose employees row is gone (e.g.
  // B-165, deleted 2026-08-05 after a duplicate-cleanup pass — see
  // deleting-an-employee-needs-a-full-text-scan) is not a leak, it is exactly what "sees everything"
  // means. Only the scoped branch (self OR visible-hr-ids, excluding resigned hr_ids) needs this
  // check at all.
  if (expectedByRole[role].canManagePayroll || expectedByRole[role].isCompanyReader) return;

  const allowed = new Set([...visibleEmployeeHrIds, user.hrId.toLowerCase()]);
  const leakedRows = data.filter((row) => {
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

    // Every table named here must be a live read surface. When one is renamed, retire the old name
    // in the same commit — a stale entry no longer reads as a pass, but it still buys no coverage.
    for (const [surface, table, select] of [
      ["Payroll RLS", "salary_records", "hr_id"],
      // Renamed from payroll_expenses by 20260713120000_rename_payroll_expenses_to_outstation.sql.
      ["Expenses RLS", "outstation_expenses", "hr_id"],
      ["Expenses RLS", "outstation_expense_requests", "employee_hr_id, status"],
      // The table the phase-2 expense read switch points at, and the one whose missing authenticated
      // SELECT grant produced the 2026-08-12 42501 incident. Staging and production now both carry
      // the grant and its policies, so this is a real read rather than a staging-only green.
      ["Expenses RLS", "expense_claims", "employee_hr_id, status"],
      ["Sales RLS", "sales_records", "employee_hr_id, manager_hr_id, line"],
    ] as const) {
      try {
        const detail = await verifyReadableSurface(client, role, table, select);
        checks.push(pass(surface, `${table} read is accepted by RLS`, role, detail));
      } catch (error) {
        checks.push(
          error instanceof SurfaceUnavailableError
            ? skip(surface, `${table} read is accepted by RLS`, error, role)
            : fail(surface, `${table} read is accepted by RLS`, error, role),
        );
      }
    }

    // These two are NOT authenticated read surfaces, on purpose. Every application read goes
    // through getSupabaseAdmin() (service_role) — 11 call sites for employee_probation, ~40 for
    // v2_vacation_requests, verified 2026-08-13, none using the user's own session — and
    // 20260812100100 states the posture outright: "service_role ONLY ... anon and authenticated are
    // deliberately not granted". This is NOT the expense_claims 42501 incident repeating: that table
    // is read with a real user session via getSupabaseRlsClientIfAvailable(), so its missing grant
    // took a live route down; neither table here has such a path. PR #2070 found both throwing
    // 42501 and left the question of which side was wrong "worth resolving deliberately rather than
    // inside this PR" — this is that resolution. Assert the denial instead of demanding a read that
    // must never succeed, so a future grant that widens either table is caught, not just a missing
    // one.
    //
    // If this ever fails with "is readable by authenticated" rather than a table-not-there or
    // wrong-code error, check phase25-staging-rls-mutation-smoke.ts / phase26 first: both issue
    // `grant select, insert, update, delete ... to authenticated` for these same two tables against
    // this same approved staging project and do not revoke it afterward. A red here on staging may
    // be that leftover grant, not a new widening — but it is still real drift worth clearing, since
    // nothing else would ever tell you the sandbox stopped matching production.
    for (const [surface, table] of [
      ["Probation RLS", "employee_probation"],
      ["Leave RLS", "v2_vacation_requests"],
    ] as const) {
      try {
        const detail = await verifyDeniedSurface(client, table);
        checks.push(pass(surface, `${table} stays service-role only`, role, detail));
      } catch (error) {
        checks.push(
          error instanceof SurfaceUnavailableError
            ? skip(surface, `${table} stays service-role only`, error, role)
            : fail(surface, `${table} stays service-role only`, error, role),
        );
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

  const failed = checks.filter((check) => check.status === "fail");
  const skipped = checks.filter((check) => check.status === "skipped");
  const passed = checks.filter((check) => check.status === "pass");
  console.log(JSON.stringify({
    failed,
    // Reported separately from `failed` so the cause is obvious at a glance, and never folded into
    // `passed`. A skipped row means this smoke names a surface that no longer exists.
    skipped,
    passed: passed.length,
    policy: {
      api: "Service-role-backed app routes must keep explicit Phoenix permission guards.",
      mode: "PHASE24 real Supabase Auth smoke is read-only and uses the approved staging sandbox only.",
      rls: "Authenticated Supabase JWTs must resolve Phoenix role/scope through current_access helpers and table policies.",
      serviceRoleOnly: "employee_probation and v2_vacation_requests must stay unreadable by authenticated — every application read of them uses the service-role client, so a grant would widen access with no consumer.",
      skipped: "A check that could not run is never a pass. Skipped rows fail this run until the surface they name is corrected.",
    },
    results: checks,
  }, null, 2));
  if (failed.length > 0 || skipped.length > 0) {
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
