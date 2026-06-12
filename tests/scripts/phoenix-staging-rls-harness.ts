import { Buffer } from "node:buffer";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type PhoenixRole =
  | "Employee"
  | "Medical Rep"
  | "District Manager"
  | "Regional Manager"
  | "National Sales Manager"
  | "Finance Manager"
  | "Talent Acquisition"
  | "CEO"
  | "Super Admin";

type TestUser = {
  hrId: string;
  loginId: string;
  password: string;
};

type TestConfig = Record<PhoenixRole, TestUser>;

type TestResult = {
  detail?: string;
  name: string;
  ok: boolean;
  role: PhoenixRole;
  table?: string;
};

type CleanupState = {
  payrollExpenseIds: string[];
  payrollExpenseReportIds: string[];
};

const roles: PhoenixRole[] = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Finance Manager",
  "Talent Acquisition",
  "CEO",
  "Super Admin",
];

const expectedByRole: Record<PhoenixRole, {
  canManageEmployees: boolean;
  canManagePayroll: boolean;
  coarseRole: string;
  isCompanyReader: boolean;
  isFinance: boolean;
  isHr: boolean;
  isSuperAdmin: boolean;
  scope: string;
}> = {
  Employee: {
    canManageEmployees: false,
    canManagePayroll: false,
    coarseRole: "employee",
    isCompanyReader: false,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "SELF",
  },
  "Medical Rep": {
    canManageEmployees: false,
    canManagePayroll: false,
    coarseRole: "employee",
    isCompanyReader: false,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "SELF",
  },
  "District Manager": {
    canManageEmployees: false,
    canManagePayroll: false,
    coarseRole: "manager",
    isCompanyReader: false,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "TEAM",
  },
  "Regional Manager": {
    canManageEmployees: false,
    canManagePayroll: false,
    coarseRole: "manager",
    isCompanyReader: false,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "HIERARCHY",
  },
  "National Sales Manager": {
    canManageEmployees: false,
    canManagePayroll: false,
    coarseRole: "manager",
    isCompanyReader: false,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "LINE",
  },
  "Finance Manager": {
    canManageEmployees: false,
    canManagePayroll: true,
    coarseRole: "finance",
    isCompanyReader: false,
    isFinance: true,
    isHr: false,
    isSuperAdmin: false,
    scope: "FINANCE",
  },
  "Talent Acquisition": {
    canManageEmployees: true,
    canManagePayroll: true,
    coarseRole: "hr",
    isCompanyReader: false,
    isFinance: false,
    isHr: true,
    isSuperAdmin: false,
    scope: "HR",
  },
  CEO: {
    canManageEmployees: false,
    canManagePayroll: false,
    coarseRole: "company_reader",
    isCompanyReader: true,
    isFinance: false,
    isHr: false,
    isSuperAdmin: false,
    scope: "COMPANY_READ",
  },
  "Super Admin": {
    canManageEmployees: true,
    canManagePayroll: true,
    coarseRole: "super_admin",
    isCompanyReader: true,
    isFinance: false,
    isHr: false,
    isSuperAdmin: true,
    scope: "SUPER_ADMIN",
  },
};

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function approvedStagingRef() {
  return process.env.PHOENIX_APPROVED_STAGING_REF?.trim() || "oaifhavixhdtwmseshff";
}

function parseUsersConfig(): TestConfig {
  const raw = requiredEnv("PHOENIX_RLS_TEST_USERS_JSON");
  const parsed = JSON.parse(raw) as Partial<TestConfig>;
  const missing = roles.filter((role) => !parsed[role]?.loginId || !parsed[role]?.password || !parsed[role]?.hrId);

  if (missing.length) {
    throw new Error(`PHOENIX_RLS_TEST_USERS_JSON is missing required users: ${missing.join(", ")}`);
  }

  return parsed as TestConfig;
}

function buildPhoenixAuthEmail(loginId: string) {
  const normalizedLoginId = loginId.trim().toLowerCase();
  const encodedLoginId = Buffer.from(normalizedLoginId).toString("hex");
  return `phx-${encodedLoginId}@auth.phoenix.local`;
}

function stagingUrl() {
  const url = requiredEnv("PHOENIX_STAGING_SUPABASE_URL").replace(/\/+$/g, "");
  const hostname = new URL(url).hostname.toLowerCase();
  if (url.includes("ozucdzovmcqvepbozvqf") || hostname.includes("ozucdzovmcqvepbozvqf")) {
    throw new Error("Refusing Phoenix HR production project ref.");
  }
  if (hostname !== `${approvedStagingRef()}.supabase.co`) {
    throw new Error("Refusing any Supabase URL except the approved Phoenix RLS testing sandbox.");
  }
  return url;
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
  const { error } = await client.auth.signInWithPassword({
    email: buildPhoenixAuthEmail(user.loginId),
    password: user.password,
  });
  if (error) throw new Error(`${role} login failed: ${error.message}`);
  return client;
}

function pass(role: PhoenixRole, name: string, table?: string, detail?: string): TestResult {
  return { detail, name, ok: true, role, table };
}

function fail(role: PhoenixRole, name: string, table: string | undefined, error: unknown): TestResult {
  const detail = error instanceof Error ? error.message : String(error);
  return { detail, name, ok: false, role, table };
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertAllowed(error: { message?: string } | null, label: string) {
  if (error) throw new Error(`${label}: expected allowed, received ${error.message}`);
}

function assertDeniedOrNoRows(error: { message?: string } | null, count: number | null | undefined, label: string) {
  if (!error && count && count > 0) {
    throw new Error(`${label}: expected denied or zero affected rows, affected ${count}`);
  }
}

async function rpcValue<T>(client: SupabaseClient, name: string): Promise<T> {
  const { data, error } = await client.rpc(name);
  if (error) throw error;
  return data as T;
}

async function verifyHelpers(client: SupabaseClient, role: PhoenixRole): Promise<TestResult[]> {
  const expected = expectedByRole[role];
  const results: TestResult[] = [];

  try {
    assertEqual(await rpcValue<string>(client, "current_phoenix_role"), role, "current_phoenix_role()");
    assertEqual(await rpcValue<string>(client, "current_access_scope"), expected.scope, "current_access_scope()");
    assertEqual(await rpcValue<boolean>(client, "current_access_is_super_admin"), expected.isSuperAdmin, "current_access_is_super_admin()");
    assertEqual(await rpcValue<boolean>(client, "current_access_is_hr"), expected.isHr, "current_access_is_hr()");
    assertEqual(await rpcValue<boolean>(client, "current_access_is_finance"), expected.isFinance, "current_access_is_finance()");
    assertEqual(await rpcValue<boolean>(client, "current_access_is_company_reader"), expected.isCompanyReader, "current_access_is_company_reader()");
    assertEqual(await rpcValue<boolean>(client, "current_access_can_manage_employees"), expected.canManageEmployees, "current_access_can_manage_employees()");
    assertEqual(await rpcValue<boolean>(client, "current_access_can_manage_payroll"), expected.canManagePayroll, "current_access_can_manage_payroll()");
    results.push(pass(role, "helper functions", "rpc"));
  } catch (error) {
    results.push(fail(role, "helper functions", "rpc", error));
  }

  return results;
}

async function verifyRoleProfile(client: SupabaseClient, role: PhoenixRole, user: TestUser): Promise<TestResult> {
  try {
    const { data, error } = await client
      .from("user_access_profiles")
      .select("hr_id, phoenix_role, role, scope_type")
      .eq("hr_id", user.hrId)
      .maybeSingle();
    assertAllowed(error, "profile select");
    if (!data) throw new Error("own access profile was not visible");
    assertEqual(data.phoenix_role, role, "phoenix_role");
    assertEqual(data.role, expectedByRole[role].coarseRole, "coarse role");
    assertEqual(data.scope_type, expectedByRole[role].scope, "scope_type");
    return pass(role, "role profile mapping", "user_access_profiles");
  } catch (error) {
    return fail(role, "role profile mapping", "user_access_profiles", error);
  }
}

async function verifyEmployeesSelect(client: SupabaseClient, role: PhoenixRole, user: TestUser): Promise<{ results: TestResult[]; visibleHrIds: Set<string> }> {
  const visibleHrIds = new Set<string>();
  try {
    const { data, error } = await client
      .from("employees")
      .select("hr_id, manager_hr_id")
      .limit(500);
    assertAllowed(error, "employees select");
    for (const row of data ?? []) {
      if (row.hr_id) visibleHrIds.add(String(row.hr_id).toLowerCase());
    }

    if ((role === "Employee" || role === "Medical Rep" || role === "Finance Manager") && visibleHrIds.size > 1) {
      throw new Error(`expected self-only or minimal employee visibility, received ${visibleHrIds.size} rows`);
    }
    if ((role === "Employee" || role === "Medical Rep") && !visibleHrIds.has(user.hrId.toLowerCase())) {
      throw new Error("own employee profile was not visible");
    }

    return { results: [pass(role, "employees select scope", "employees", `${visibleHrIds.size} visible rows`)], visibleHrIds };
  } catch (error) {
    return { results: [fail(role, "employees select scope", "employees", error)], visibleHrIds };
  }
}

async function verifySalaryRecordsSelect(client: SupabaseClient, role: PhoenixRole, user: TestUser, visibleHrIds: Set<string>): Promise<TestResult[]> {
  try {
    const { data, error } = await client
      .from("salary_records")
      .select("id, batch_id, hr_id")
      .limit(500);
    assertAllowed(error, "salary_records select");

    if (!expectedByRole[role].canManagePayroll) {
      const badRows = (data ?? []).filter((row) => {
        const hrId = String(row.hr_id ?? "").toLowerCase();
        return hrId !== user.hrId.toLowerCase() && !visibleHrIds.has(hrId);
      });
      if (badRows.length) {
        throw new Error(`found ${badRows.length} salary rows outside own/visible employee scope`);
      }
    }

    return [pass(role, "salary_records select scope", "salary_records", `${data?.length ?? 0} visible rows`)];
  } catch (error) {
    return [fail(role, "salary_records select scope", "salary_records", error)];
  }
}

async function verifySalaryBatchesSelect(client: SupabaseClient, role: PhoenixRole): Promise<TestResult[]> {
  try {
    const { data: batches, error } = await client
      .from("salary_batches")
      .select("id")
      .limit(100);
    assertAllowed(error, "salary_batches select");

    if (!expectedByRole[role].canManagePayroll && (batches?.length ?? 0) > 0) {
      const { data: records, error: recordsError } = await client
        .from("salary_records")
        .select("batch_id")
        .limit(500);
      assertAllowed(recordsError, "salary_records select for batch correlation");
      const visibleBatchIds = new Set((records ?? []).map((row) => String(row.batch_id)));
      const leaked = (batches ?? []).filter((batch) => !visibleBatchIds.has(String(batch.id)));
      if (leaked.length) throw new Error(`found ${leaked.length} salary batches without visible salary records`);
    }

    return [pass(role, "salary_batches select scope", "salary_batches", `${batches?.length ?? 0} visible rows`)];
  } catch (error) {
    return [fail(role, "salary_batches select scope", "salary_batches", error)];
  }
}

function stagingMutationsEnabled() {
  return process.env.PHOENIX_RLS_ALLOW_STAGING_MUTATIONS === "1";
}

async function verifyPayrollExpenses(client: SupabaseClient, role: PhoenixRole, user: TestUser, cleanup: CleanupState): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const tripId = `PHX_RLS_TEST_${role.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${Date.now()}`;

  try {
    const { data, error } = await client
      .from("payroll_expenses")
      .select("id, hr_id")
      .limit(500);
    assertAllowed(error, "payroll_expenses select");
    results.push(pass(role, "payroll_expenses select", "payroll_expenses", `${data?.length ?? 0} visible rows`));
  } catch (error) {
    results.push(fail(role, "payroll_expenses select", "payroll_expenses", error));
  }

  if (!stagingMutationsEnabled()) {
    results.push(pass(role, "payroll_expenses mutations skipped", "payroll_expenses", "set PHOENIX_RLS_ALLOW_STAGING_MUTATIONS=1"));
    return results;
  }

  try {
    const { data, error } = await client
      .from("payroll_expenses")
      .insert({
        expense_date: new Date().toISOString().slice(0, 10),
        hr_id: user.hrId,
        specialist: `PHX RLS ${role}`,
        source_file_name: "PHX_RLS_STAGING_TEST",
        status: "rls_test",
        total: 1,
        travel_cost: 1,
        trip_id: tripId,
      })
      .select("id")
      .maybeSingle();

    const insertShouldPass = expectedByRole[role].canManagePayroll || role === "Employee" || role === "Medical Rep";
    if (data?.id) cleanup.payrollExpenseIds.push(String(data.id));
    if (insertShouldPass) {
      assertAllowed(error, "own payroll_expenses insert");
      results.push(pass(role, "payroll_expenses insert own", "payroll_expenses"));
    } else {
      assertDeniedOrNoRows(error, data ? 1 : 0, "own payroll_expenses insert");
      results.push(pass(role, "payroll_expenses insert denied", "payroll_expenses"));
      return results;
    }

    const insertedId = data?.id;
    const { count: updateCount, error: updateError } = await client
      .from("payroll_expenses")
      .update({ hr_comment: "PHX_RLS_STAGING_TEST" }, { count: "exact" })
      .eq("id", insertedId);

    if (expectedByRole[role].canManagePayroll) {
      assertAllowed(updateError, "payroll_expenses update");
      results.push(pass(role, "payroll_expenses update allowed", "payroll_expenses"));
    } else {
      assertDeniedOrNoRows(updateError, updateCount, "payroll_expenses update");
      results.push(pass(role, "payroll_expenses update denied", "payroll_expenses"));
    }

    const { count: deleteCount, error: deleteError } = await client
      .from("payroll_expenses")
      .delete({ count: "exact" })
      .eq("id", insertedId);

    if (expectedByRole[role].canManagePayroll) {
      assertAllowed(deleteError, "payroll_expenses delete");
      results.push(pass(role, "payroll_expenses delete allowed", "payroll_expenses"));
    } else {
      assertDeniedOrNoRows(deleteError, deleteCount, "payroll_expenses delete");
      results.push(pass(role, "payroll_expenses delete denied", "payroll_expenses"));
    }
  } catch (error) {
    results.push(fail(role, "payroll_expenses mutations", "payroll_expenses", error));
  }

  return results;
}

async function verifyPayrollExpenseReports(client: SupabaseClient, role: PhoenixRole, cleanup: CleanupState): Promise<TestResult[]> {
  const results: TestResult[] = [];
  try {
    const { data, error } = await client
      .from("payroll_expense_reports")
      .select("id")
      .limit(100);
    assertAllowed(error, "payroll_expense_reports select");
    results.push(pass(role, "payroll_expense_reports select", "payroll_expense_reports", `${data?.length ?? 0} visible rows`));
  } catch (error) {
    results.push(fail(role, "payroll_expense_reports select", "payroll_expense_reports", error));
  }

  if (!stagingMutationsEnabled()) {
    results.push(pass(role, "payroll_expense_reports mutations skipped", "payroll_expense_reports", "set PHOENIX_RLS_ALLOW_STAGING_MUTATIONS=1"));
    return results;
  }

  try {
    const { data, error } = await client
      .from("payroll_expense_reports")
      .insert({
        file_name: `PHX_RLS_STAGING_TEST_${role}_${Date.now()}.xlsx`,
        row_count: 0,
        total_expenses: 0,
      })
      .select("id")
      .maybeSingle();

    if (expectedByRole[role].canManagePayroll) {
      assertAllowed(error, "payroll_expense_reports insert");
      if (data?.id) cleanup.payrollExpenseReportIds.push(String(data.id));
      results.push(pass(role, "payroll_expense_reports insert allowed", "payroll_expense_reports"));
    } else {
      if (data?.id) cleanup.payrollExpenseReportIds.push(String(data.id));
      assertDeniedOrNoRows(error, data ? 1 : 0, "payroll_expense_reports insert");
      results.push(pass(role, "payroll_expense_reports insert denied", "payroll_expense_reports"));
      return results;
    }

    const insertedId = data?.id;
    const { count: updateCount, error: updateError } = await client
      .from("payroll_expense_reports")
      .update({ file_name: `PHX_RLS_STAGING_TEST_UPDATED_${Date.now()}.xlsx` }, { count: "exact" })
      .eq("id", insertedId);
    assertAllowed(updateError, "payroll_expense_reports update");
    results.push(pass(role, "payroll_expense_reports update allowed", "payroll_expense_reports", `${updateCount ?? 0} affected`));

    const { count: deleteCount, error: deleteError } = await client
      .from("payroll_expense_reports")
      .delete({ count: "exact" })
      .eq("id", insertedId);
    assertAllowed(deleteError, "payroll_expense_reports delete");
    cleanup.payrollExpenseReportIds = cleanup.payrollExpenseReportIds.filter((id) => id !== String(insertedId));
    results.push(pass(role, "payroll_expense_reports delete allowed", "payroll_expense_reports", `${deleteCount ?? 0} affected`));
  } catch (error) {
    results.push(fail(role, "payroll_expense_reports mutations", "payroll_expense_reports", error));
  }

  return results;
}

async function verifyUserAdminRestrictions(client: SupabaseClient, role: PhoenixRole, user: TestUser): Promise<TestResult[]> {
  const results: TestResult[] = [];
  if (!stagingMutationsEnabled()) {
    results.push(pass(role, "user_access_profiles mutation skipped", "user_access_profiles", "set PHOENIX_RLS_ALLOW_STAGING_MUTATIONS=1"));
    return results;
  }

  try {
    const { count, error } = await client
      .from("user_access_profiles")
      .update({ scope_type: expectedByRole[role].scope }, { count: "exact" })
      .eq("hr_id", user.hrId);

    if (role === "Super Admin") {
      assertAllowed(error, "super admin user_access_profiles update");
      results.push(pass(role, "user_access_profiles admin update allowed", "user_access_profiles", `${count ?? 0} affected`));
    } else {
      assertDeniedOrNoRows(error, count, "non-super-admin user_access_profiles update");
      results.push(pass(role, "user_access_profiles admin update denied", "user_access_profiles"));
    }
  } catch (error) {
    results.push(fail(role, "user_access_profiles admin write restriction", "user_access_profiles", error));
  }

  return results;
}

async function verifyProtectedMutations(client: SupabaseClient, role: PhoenixRole, user: TestUser): Promise<TestResult[]> {
  const results: TestResult[] = [];
  if (!stagingMutationsEnabled()) {
    results.push(pass(role, "protected mutations skipped", "employees/salary_records", "set PHOENIX_RLS_ALLOW_STAGING_MUTATIONS=1"));
    return results;
  }

  try {
    const { data: currentEmployee } = await client
      .from("employees")
      .select("updated_at")
      .eq("hr_id", user.hrId)
      .maybeSingle();

    const { count, error } = await client
      .from("employees")
      .update({ updated_at: currentEmployee?.updated_at ?? new Date().toISOString() }, { count: "exact" })
      .eq("hr_id", user.hrId);

    const allowed = expectedByRole[role].canManageEmployees;
    if (allowed) {
      assertAllowed(error, "employees update");
      results.push(pass(role, "employees update allowed", "employees", `${count ?? 0} affected`));
    } else {
      assertDeniedOrNoRows(error, count, "employees update");
      results.push(pass(role, "employees update denied", "employees"));
    }
  } catch (error) {
    results.push(fail(role, "employees mutation", "employees", error));
  }

  try {
    const { data: target } = await client
      .from("salary_records")
      .select("id, comment")
      .limit(1)
      .maybeSingle();
    if (!target?.id) {
      results.push(pass(role, "salary_records update skipped", "salary_records", "no visible target row"));
      return results;
    }

    const { count, error } = await client
      .from("salary_records")
      .update({ comment: target.comment ?? null }, { count: "exact" })
      .eq("id", target.id);

    if (expectedByRole[role].canManagePayroll) {
      assertAllowed(error, "salary_records update");
      results.push(pass(role, "salary_records update allowed", "salary_records", `${count ?? 0} affected`));
    } else {
      assertDeniedOrNoRows(error, count, "salary_records update");
      results.push(pass(role, "salary_records update denied", "salary_records"));
    }
  } catch (error) {
    results.push(fail(role, "salary_records mutation", "salary_records", error));
  }

  return results;
}

async function verifySalesRecords(client: SupabaseClient, role: PhoenixRole): Promise<TestResult[]> {
  const results: TestResult[] = [];
  try {
    const { data, error } = await client
      .from("sales_records")
      .select("id, employee_hr_id, manager_hr_id, line")
      .limit(500);
    assertAllowed(error, "sales_records select");
    results.push(pass(role, "sales_records read", "sales_records", `${data?.length ?? 0} visible rows`));
  } catch (error) {
    results.push(fail(role, "sales_records read", "sales_records", error));
  }
  return results;
}

async function runRole(role: PhoenixRole, user: TestUser, cleanup: CleanupState): Promise<TestResult[]> {
  const client = await signIn(role, user);
  const results: TestResult[] = [];

  results.push(...await verifyHelpers(client, role));
  results.push(await verifyRoleProfile(client, role, user));

  const employeeScope = await verifyEmployeesSelect(client, role, user);
  results.push(...employeeScope.results);

  results.push(...await verifySalaryRecordsSelect(client, role, user, employeeScope.visibleHrIds));
  results.push(...await verifySalaryBatchesSelect(client, role));
  results.push(...await verifyPayrollExpenses(client, role, user, cleanup));
  results.push(...await verifyPayrollExpenseReports(client, role, cleanup));
  results.push(...await verifyUserAdminRestrictions(client, role, user));
  results.push(...await verifyProtectedMutations(client, role, user));
  results.push(...await verifySalesRecords(client, role));

  await client.auth.signOut();
  return results;
}

async function cleanupStagingRows(users: TestConfig, cleanup: CleanupState): Promise<TestResult[]> {
  const role: PhoenixRole = "Super Admin";
  const client = await signIn(role, users[role]);
  const results: TestResult[] = [];

  if (cleanup.payrollExpenseIds.length > 0) {
    try {
      const { count, error } = await client
        .from("payroll_expenses")
        .delete({ count: "exact" })
        .in("id", cleanup.payrollExpenseIds);
      assertAllowed(error, "payroll_expenses cleanup");
      results.push(pass(role, "cleanup staging payroll_expenses", "payroll_expenses", `${count ?? 0} deleted`));
    } catch (error) {
      results.push(fail(role, "cleanup staging payroll_expenses", "payroll_expenses", error));
    }
  }

  if (cleanup.payrollExpenseReportIds.length > 0) {
    try {
      const { count, error } = await client
        .from("payroll_expense_reports")
        .delete({ count: "exact" })
        .in("id", cleanup.payrollExpenseReportIds);
      assertAllowed(error, "payroll_expense_reports cleanup");
      results.push(pass(role, "cleanup staging payroll_expense_reports", "payroll_expense_reports", `${count ?? 0} deleted`));
    } catch (error) {
      results.push(fail(role, "cleanup staging payroll_expense_reports", "payroll_expense_reports", error));
    }
  }

  await client.auth.signOut();
  return results;
}

async function main() {
  const users = parseUsersConfig();
  const results: TestResult[] = [];
  const cleanup: CleanupState = {
    payrollExpenseIds: [],
    payrollExpenseReportIds: [],
  };

  for (const role of roles) {
    try {
      results.push(...await runRole(role, users[role], cleanup));
    } catch (error) {
      results.push(fail(role, "role harness", undefined, error));
    }
  }

  results.push(...await cleanupStagingRows(users, cleanup));

  let failed = 0;
  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL";
    const table = result.table ? ` [${result.table}]` : "";
    const detail = result.detail ? ` - ${result.detail}` : "";
    console.log(`${status} ${result.role}${table}: ${result.name}${detail}`);
    if (!result.ok) failed += 1;
  }

  const passed = results.length - failed;
  console.log(`\nRLS harness complete: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

await main();
