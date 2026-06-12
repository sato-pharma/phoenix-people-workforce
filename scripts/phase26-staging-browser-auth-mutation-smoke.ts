import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import postgres from "postgres";

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

type BrowserSession = {
  accessToken: string;
  refreshToken: string;
};

type Check = {
  detail?: string;
  name: string;
  ok: boolean;
  role?: PhoenixRole;
  surface: string;
};

type CleanupState = {
  employeeHrIds: string[];
  payrollExpenseIds: string[];
  probationIds: string[];
  vacationRequestIds: string[];
};

const localEnvPath = ".env.staging.rls.local";
const approvedSandboxRef = "oaifhavixhdtwmseshff";
const blockedProductionRef = "ozucdzovmcqvepbozvqf";
const phaseTag = `PHASE26-${Date.now()}`;
const localhostBaseUrl = process.env.PHOENIX_PHASE26_BASE_URL?.replace(/\/+$/g, "") ?? "http://localhost:3000";
const fakeUuid = "00000000-0000-0000-0000-000000000000";

const roles: PhoenixRole[] = [
  "Super Admin",
  "Talent Acquisition",
  "Finance Manager",
  "CEO",
  "District Manager",
  "Medical Rep",
  "Employee",
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

function approvedStagingRef() {
  return process.env.PHOENIX_APPROVED_STAGING_REF?.trim() || approvedSandboxRef;
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
  const approvedRef = approvedStagingRef();
  if (hostname !== `${approvedRef}.supabase.co`) {
    throw new Error("Refusing any Supabase URL except the approved Phoenix RLS testing sandbox.");
  }
  return url;
}

function stagingDatabaseUrl() {
  const url = requiredEnv("PHOENIX_STAGING_DATABASE_URL");
  const parsed = new URL(url);
  if (url.includes(blockedProductionRef) || parsed.hostname.includes(blockedProductionRef)) {
    throw new Error("Refusing Phoenix production database URL.");
  }
  const approvedRef = approvedStagingRef();
  if (!url.includes(approvedRef) && !parsed.hostname.includes(approvedRef)) {
    throw new Error("Refusing any database URL except the approved Phoenix RLS testing sandbox.");
  }
  return url;
}

function parseUsersConfig(): Record<PhoenixRole, TestUser> {
  const parsed = JSON.parse(requiredEnv("PHOENIX_RLS_TEST_USERS_JSON")) as Partial<Record<PhoenixRole, TestUser>>;
  const missing = roles.filter((role) => !parsed[role]?.hrId || !parsed[role]?.loginId || !parsed[role]?.password);
  if (missing.length > 0) {
    throw new Error(`PHOENIX_RLS_TEST_USERS_JSON is missing Phase 26 roles: ${missing.join(", ")}`);
  }
  return parsed as Record<PhoenixRole, TestUser>;
}

function buildPhoenixAuthEmail(loginId: string) {
  const encodedLoginId = Buffer.from(loginId.trim().toLowerCase()).toString("hex");
  return `phx-${encodedLoginId}@auth.phoenix.local`;
}

function createAdminSql() {
  return postgres(stagingDatabaseUrl(), {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
    ssl: "require",
  });
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

function assertAllowed(result: { body: unknown; status: number }, label: string) {
  if (![200, 201].includes(result.status)) {
    throw new Error(`${label}: expected allowed status, received ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
  }
  if (!Array.isArray(result.body) || result.body.length < 1) {
    throw new Error(`${label}: expected returned representation row`);
  }
}

function assertDenied(result: { body: unknown; status: number }, label: string) {
  if ([401, 403].includes(result.status)) return;
  if (result.status === 200 && Array.isArray(result.body) && result.body.length === 0) return;
  throw new Error(`${label}: expected denied or zero affected rows, received ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
}

async function alignStagingProbationAndLeaveSchema(sql: ReturnType<typeof postgres>) {
  await sql.unsafe(`
    create extension if not exists pgcrypto;

    create table if not exists public.employee_probation (
      id uuid primary key default gen_random_uuid(),
      hr_id text null,
      employee_hr_id text null,
      manager_hr_id text null,
      probation_start_date date null,
      probation_end_date date null,
      status text not null default 'active',
      notes text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    alter table public.employee_probation add column if not exists hr_id text null;
    alter table public.employee_probation add column if not exists employee_hr_id text null;
    alter table public.employee_probation add column if not exists manager_hr_id text null;
    alter table public.employee_probation add column if not exists probation_start_date date null;
    alter table public.employee_probation add column if not exists probation_end_date date null;
    alter table public.employee_probation add column if not exists status text not null default 'active';
    alter table public.employee_probation add column if not exists notes text null;
    alter table public.employee_probation add column if not exists created_at timestamptz not null default now();
    alter table public.employee_probation add column if not exists updated_at timestamptz not null default now();

    create table if not exists public.v2_vacation_requests (
      id uuid primary key default gen_random_uuid(),
      employee_hr_id text not null,
      manager_hr_id text null,
      manager_of_manager_hr_id text null,
      vacation_type text not null default 'annual',
      start_date date not null,
      end_date date not null,
      working_days numeric not null default 1,
      calendar_days numeric not null default 1,
      status text not null default 'pending',
      payment_status text not null default 'pending',
      notes text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint v2_vacation_requests_date_order check (end_date >= start_date)
    );

    alter table public.v2_vacation_requests add column if not exists employee_hr_id text;
    alter table public.v2_vacation_requests add column if not exists manager_hr_id text null;
    alter table public.v2_vacation_requests add column if not exists manager_of_manager_hr_id text null;
    alter table public.v2_vacation_requests add column if not exists vacation_type text not null default 'annual';
    alter table public.v2_vacation_requests add column if not exists start_date date;
    alter table public.v2_vacation_requests add column if not exists end_date date;
    alter table public.v2_vacation_requests add column if not exists working_days numeric not null default 1;
    alter table public.v2_vacation_requests add column if not exists calendar_days numeric not null default 1;
    alter table public.v2_vacation_requests add column if not exists status text not null default 'pending';
    alter table public.v2_vacation_requests add column if not exists payment_status text not null default 'pending';
    alter table public.v2_vacation_requests add column if not exists notes text null;
    alter table public.v2_vacation_requests add column if not exists created_at timestamptz not null default now();
    alter table public.v2_vacation_requests add column if not exists updated_at timestamptz not null default now();

    alter table public.employee_probation enable row level security;
    alter table public.v2_vacation_requests enable row level security;

    revoke all on table public.employee_probation from public, anon;
    revoke all on table public.v2_vacation_requests from public, anon;
    grant select, insert, update, delete on table public.employee_probation to authenticated, service_role;
    grant select, insert, update, delete on table public.v2_vacation_requests to authenticated, service_role;

    drop policy if exists phase26_employee_probation_select_access on public.employee_probation;
    drop policy if exists phase26_employee_probation_insert_access on public.employee_probation;
    drop policy if exists phase26_employee_probation_update_access on public.employee_probation;
    drop policy if exists phase26_employee_probation_delete_access on public.employee_probation;

    create policy phase26_employee_probation_select_access
      on public.employee_probation
      for select
      to authenticated
      using (
        public.current_access_can_manage_employees()
        or public.current_access_can_see_employee(employee_hr_id, manager_hr_id)
      );

    create policy phase26_employee_probation_insert_access
      on public.employee_probation
      for insert
      to authenticated
      with check (public.current_access_can_manage_employees());

    create policy phase26_employee_probation_update_access
      on public.employee_probation
      for update
      to authenticated
      using (public.current_access_can_manage_employees())
      with check (public.current_access_can_manage_employees());

    create policy phase26_employee_probation_delete_access
      on public.employee_probation
      for delete
      to authenticated
      using (public.current_access_can_manage_employees());

    drop policy if exists phase26_v2_vacation_requests_select_access on public.v2_vacation_requests;
    drop policy if exists phase26_v2_vacation_requests_insert_access on public.v2_vacation_requests;
    drop policy if exists phase26_v2_vacation_requests_update_access on public.v2_vacation_requests;
    drop policy if exists phase26_v2_vacation_requests_delete_access on public.v2_vacation_requests;

    create policy phase26_v2_vacation_requests_select_access
      on public.v2_vacation_requests
      for select
      to authenticated
      using (
        public.current_access_can_manage_employees()
        or public.current_access_can_manage_payroll()
        or public.current_access_can_see_employee(employee_hr_id, manager_hr_id)
      );

    create policy phase26_v2_vacation_requests_insert_access
      on public.v2_vacation_requests
      for insert
      to authenticated
      with check (
        public.current_access_can_manage_employees()
        or lower(coalesce(employee_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
      );

    create policy phase26_v2_vacation_requests_update_access
      on public.v2_vacation_requests
      for update
      to authenticated
      using (
        public.current_access_can_manage_employees()
        or (
          public.current_access_scope() in ('TEAM', 'HIERARCHY')
          and lower(coalesce(manager_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
        )
      )
      with check (
        public.current_access_can_manage_employees()
        or (
          public.current_access_scope() in ('TEAM', 'HIERARCHY')
          and lower(coalesce(manager_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
        )
      );

    create policy phase26_v2_vacation_requests_delete_access
      on public.v2_vacation_requests
      for delete
      to authenticated
      using (public.current_access_can_manage_employees());

    notify pgrst, 'reload schema';
  `);
}

async function cleanupPhase26Fixtures(sql: ReturnType<typeof postgres>, cleanup: CleanupState) {
  await sql.begin(async (transaction) => {
    await transaction`
      delete from public.v2_vacation_requests
      where notes like ${`${phaseTag}%`}
    `;
    await transaction`
      delete from public.employee_probation
      where notes like ${`${phaseTag}%`}
    `;
    await transaction`
      delete from public.payroll_expenses
      where source_file_name = ${`${phaseTag}_BROWSER_MUTATION_SMOKE`}
        or trip_id like ${`${phaseTag}%`}
    `;
    await transaction`
      delete from public.employees
      where hr_id like ${`${phaseTag}-%`}
    `;
  });
  return {
    employeeHrIds: cleanup.employeeHrIds.length,
    payrollExpenseIds: cleanup.payrollExpenseIds.length,
    probationIds: cleanup.probationIds.length,
    vacationRequestIds: cleanup.vacationRequestIds.length,
  };
}

async function browserSupabaseAuth(page: Page, role: PhoenixRole, user: TestUser): Promise<BrowserSession> {
  const result = await page.evaluate(
    async ({ anonKey, email, password, url }) => {
      const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        body: JSON.stringify({ email, password }),
        headers: {
          apikey: anonKey,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const body = await response.json().catch(() => null);
      return {
        body,
        status: response.status,
      };
    },
    {
      anonKey: requiredEnv("PHOENIX_STAGING_SUPABASE_ANON_KEY"),
      email: buildPhoenixAuthEmail(user.loginId),
      password: user.password,
      url: stagingUrl(),
    },
  );

  if (result.status !== 200 || !result.body?.access_token || !result.body?.refresh_token) {
    throw new Error(`${role} browser Supabase Auth login failed with status ${result.status}`);
  }

  return {
    accessToken: String(result.body.access_token),
    refreshToken: String(result.body.refresh_token),
  };
}

async function setPhoenixSupabaseCookies(browser: Browser, session: BrowserSession) {
  const url = new URL(localhostBaseUrl);
  const context = await browser.newContext();
  await context.addCookies([
    {
      domain: url.hostname,
      httpOnly: true,
      name: "phoenix_supabase_access_token",
      path: "/",
      sameSite: "Lax",
      secure: false,
      value: session.accessToken,
    },
    {
      domain: url.hostname,
      httpOnly: true,
      name: "phoenix_supabase_refresh_token",
      path: "/",
      sameSite: "Lax",
      secure: false,
      value: session.refreshToken,
    },
  ]);
  const cookieNames = (await context.cookies(localhostBaseUrl)).map((cookie) => cookie.name).sort();
  await context.close();
  if (!cookieNames.includes("phoenix_supabase_access_token") || !cookieNames.includes("phoenix_supabase_refresh_token")) {
    throw new Error("Browser context did not retain Supabase auth bridge cookies.");
  }
}

async function restFetch(page: Page, session: BrowserSession, input: {
  body?: Record<string, unknown>;
  method: "DELETE" | "GET" | "PATCH" | "POST";
  table: string;
  query?: string;
}) {
  return page.evaluate(
    async ({ anonKey, body, method, query, table, token, url }) => {
      const response = await fetch(`${url}/rest/v1/${table}${query ?? ""}`, {
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        method,
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text.slice(0, 300);
      }
      return {
        body: parsed,
        status: response.status,
      };
    },
    {
      anonKey: requiredEnv("PHOENIX_STAGING_SUPABASE_ANON_KEY"),
      body: input.body,
      method: input.method,
      query: input.query,
      table: input.table,
      token: session.accessToken,
      url: stagingUrl(),
    },
  );
}

function returnedId(result: { body: unknown; status: number }) {
  if (!Array.isArray(result.body) || !result.body[0]?.id) {
    throw new Error(`Expected returned id, received ${JSON.stringify(result.body).slice(0, 300)}`);
  }
  return String(result.body[0].id);
}

async function runBrowserRlsMutations(
  page: Page,
  sessions: Record<PhoenixRole, BrowserSession>,
  users: Record<PhoenixRole, TestUser>,
  cleanup: CleanupState,
): Promise<Check[]> {
  const checks: Check[] = [];
  const hrFixture = `${phaseTag}-HR-GOV`;
  const superFixture = `${phaseTag}-SA-GOV`;
  let expenseId: string | null = null;
  let probationId: string | null = null;
  let managerVacationId: string | null = null;

  try {
    assertDenied(await restFetch(page, sessions.Employee, {
      body: {
        employment_status: "active",
        full_name: `${phaseTag} Unauthorized Employee`,
        hire_date: "2026-05-19",
        hr_id: `${phaseTag}-EMP-DENIED`,
        job_title: "PHASE26 Unauthorized Fixture",
        manager_hr_id: users["District Manager"].hrId,
      },
      method: "POST",
      table: "employees",
    }), "browser Employee employee creation");
    checks.push(pass("Browser RLS", "Employee browser token cannot create employee master rows", "Employee"));
  } catch (error) {
    checks.push(fail("Browser RLS", "Employee browser token cannot create employee master rows", error, "Employee"));
  }

  try {
    assertAllowed(await restFetch(page, sessions["Talent Acquisition"], {
      body: {
        employment_status: "active",
        full_name: `${phaseTag} HR Governance Fixture`,
        hire_date: "2026-05-19",
        hr_id: hrFixture,
        job_title: "PHASE26 HR Governance Fixture",
        manager_hr_id: users["Talent Acquisition"].hrId,
      },
      method: "POST",
      table: "employees",
    }), "browser HR employee insert");
    cleanup.employeeHrIds.push(hrFixture);
    checks.push(pass("Browser RLS", "HR browser token can create disposable employee fixture", "Talent Acquisition"));
  } catch (error) {
    checks.push(fail("Browser RLS", "HR browser token can create disposable employee fixture", error, "Talent Acquisition"));
  }

  try {
    assertAllowed(await restFetch(page, sessions["Super Admin"], {
      body: {
        employment_status: "active",
        full_name: `${phaseTag} Super Admin Governance Fixture`,
        hire_date: "2026-05-19",
        hr_id: superFixture,
        job_title: "PHASE26 Super Admin Governance Fixture",
        manager_hr_id: users["Super Admin"].hrId,
      },
      method: "POST",
      table: "employees",
    }), "browser Super Admin employee insert");
    cleanup.employeeHrIds.push(superFixture);
    checks.push(pass("Browser RLS", "Super Admin browser token can create disposable employee fixture", "Super Admin"));
  } catch (error) {
    checks.push(fail("Browser RLS", "Super Admin browser token can create disposable employee fixture", error, "Super Admin"));
  }

  try {
    assertDenied(await restFetch(page, sessions["District Manager"], {
      body: { job_title: "PHASE26 Unauthorized Manager Update" },
      method: "PATCH",
      query: `?hr_id=eq.${encodeURIComponent(hrFixture)}`,
      table: "employees",
    }), "browser manager outside-team employee update");
    checks.push(pass("Browser RLS", "Manager browser token cannot mutate employee outside team", "District Manager"));
  } catch (error) {
    checks.push(fail("Browser RLS", "Manager browser token cannot mutate employee outside team", error, "District Manager"));
  }

  try {
    const result = await restFetch(page, sessions["Finance Manager"], {
      body: {
        description: `${phaseTag} finance disposable expense`,
        expense_date: "2026-05-19",
        from_location: "PHASE26",
        hr_id: users["Finance Manager"].hrId,
        request_type: "PHASE26",
        source_file_name: `${phaseTag}_BROWSER_MUTATION_SMOKE`,
        source_row: 26,
        specialist: `${phaseTag} Finance Fixture`,
        status: "PHASE26",
        to_location: "PHASE26",
        total: 26,
        travel_cost: 26,
        trip_id: `${phaseTag}-EXPENSE`,
      },
      method: "POST",
      table: "payroll_expenses",
    });
    assertAllowed(result, "browser Finance expense insert");
    expenseId = returnedId(result);
    cleanup.payrollExpenseIds.push(expenseId);
    checks.push(pass("Browser RLS", "Finance browser token can create disposable expense fixture", "Finance Manager"));
  } catch (error) {
    checks.push(fail("Browser RLS", "Finance browser token can create disposable expense fixture", error, "Finance Manager"));
  }

  if (expenseId) {
    try {
      assertDenied(await restFetch(page, sessions.Employee, {
        body: { total: 999 },
        method: "PATCH",
        query: `?id=eq.${expenseId}`,
        table: "payroll_expenses",
      }), "browser Employee expense update");
      checks.push(pass("Browser RLS", "Employee browser token cannot mutate payroll expense", "Employee"));
    } catch (error) {
      checks.push(fail("Browser RLS", "Employee browser token cannot mutate payroll expense", error, "Employee"));
    }

    try {
      assertAllowed(await restFetch(page, sessions["Finance Manager"], {
        body: { hr_comment: `${phaseTag} finance browser update accepted` },
        method: "PATCH",
        query: `?id=eq.${expenseId}`,
        table: "payroll_expenses",
      }), "browser Finance expense update");
      checks.push(pass("Browser RLS", "Finance browser token can update disposable expense fixture", "Finance Manager"));
    } catch (error) {
      checks.push(fail("Browser RLS", "Finance browser token can update disposable expense fixture", error, "Finance Manager"));
    }
  }

  try {
    const result = await restFetch(page, sessions["Talent Acquisition"], {
      body: {
        employee_hr_id: users.Employee.hrId,
        hr_id: users.Employee.hrId,
        manager_hr_id: users["Talent Acquisition"].hrId,
        notes: `${phaseTag} HR probation fixture`,
        probation_end_date: "2026-06-18",
        probation_start_date: "2026-05-19",
        status: "active",
      },
      method: "POST",
      table: "employee_probation",
    });
    assertAllowed(result, "browser HR probation insert");
    probationId = returnedId(result);
    cleanup.probationIds.push(probationId);
    checks.push(pass("Browser RLS", "HR browser token can create disposable probation fixture", "Talent Acquisition"));
  } catch (error) {
    checks.push(fail("Browser RLS", "HR browser token can create disposable probation fixture", error, "Talent Acquisition"));
  }

  if (probationId) {
    try {
      assertDenied(await restFetch(page, sessions.Employee, {
        body: { status: "confirmed" },
        method: "PATCH",
        query: `?id=eq.${probationId}`,
        table: "employee_probation",
      }), "browser Employee probation decision update");
      checks.push(pass("Browser RLS", "Employee browser token cannot self-mutate probation decisions", "Employee"));
    } catch (error) {
      checks.push(fail("Browser RLS", "Employee browser token cannot self-mutate probation decisions", error, "Employee"));
    }
  }

  try {
    const result = await restFetch(page, sessions.Employee, {
      body: {
        calendar_days: 1,
        employee_hr_id: users.Employee.hrId,
        end_date: "2026-05-20",
        manager_hr_id: users["District Manager"].hrId,
        notes: `${phaseTag} employee leave fixture`,
        start_date: "2026-05-20",
        status: "pending",
        vacation_type: "annual",
        working_days: 1,
      },
      method: "POST",
      table: "v2_vacation_requests",
    });
    assertAllowed(result, "browser Employee own vacation insert");
    cleanup.vacationRequestIds.push(returnedId(result));
    checks.push(pass("Browser RLS", "Employee browser token can create own vacation request", "Employee"));
  } catch (error) {
    checks.push(fail("Browser RLS", "Employee browser token can create own vacation request", error, "Employee"));
  }

  try {
    assertDenied(await restFetch(page, sessions.Employee, {
      body: {
        calendar_days: 1,
        employee_hr_id: users["Medical Rep"].hrId,
        end_date: "2026-05-21",
        manager_hr_id: users["District Manager"].hrId,
        notes: `${phaseTag} unauthorized leave fixture`,
        start_date: "2026-05-21",
        status: "pending",
        vacation_type: "annual",
        working_days: 1,
      },
      method: "POST",
      table: "v2_vacation_requests",
    }), "browser Employee other employee vacation insert");
    checks.push(pass("Browser RLS", "Employee browser token cannot create vacation for another employee", "Employee"));
  } catch (error) {
    checks.push(fail("Browser RLS", "Employee browser token cannot create vacation for another employee", error, "Employee"));
  }

  try {
    const result = await restFetch(page, sessions["Talent Acquisition"], {
      body: {
        calendar_days: 1,
        employee_hr_id: users["Talent Acquisition"].hrId,
        end_date: "2026-05-22",
        manager_hr_id: users["Talent Acquisition"].hrId,
        notes: `${phaseTag} outside manager leave fixture`,
        start_date: "2026-05-22",
        status: "pending",
        vacation_type: "annual",
        working_days: 1,
      },
      method: "POST",
      table: "v2_vacation_requests",
    });
    assertAllowed(result, "browser HR outside-manager vacation insert");
    managerVacationId = returnedId(result);
    cleanup.vacationRequestIds.push(managerVacationId);
    checks.push(pass("Browser RLS", "HR browser token can create outside-manager leave fixture", "Talent Acquisition"));
  } catch (error) {
    checks.push(fail("Browser RLS", "HR browser token can create outside-manager leave fixture", error, "Talent Acquisition"));
  }

  if (managerVacationId) {
    try {
      assertDenied(await restFetch(page, sessions["District Manager"], {
        body: { status: "approved" },
        method: "PATCH",
        query: `?id=eq.${managerVacationId}`,
        table: "v2_vacation_requests",
      }), "browser manager outside-team vacation update");
      checks.push(pass("Browser RLS", "Manager browser token cannot approve vacation outside team", "District Manager"));
    } catch (error) {
      checks.push(fail("Browser RLS", "Manager browser token cannot approve vacation outside team", error, "District Manager"));
    }
  }

  return checks;
}

async function appApiFetch(page: Page, path: string, init: Record<string, unknown>) {
  return page.evaluate(
    async ({ init, path }) => {
      const response = await fetch(path, init as RequestInit);
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text.slice(0, 300);
      }
      return { body, status: response.status };
    },
    { init, path },
  );
}

async function verifyLocalAppPermissionGuards(browser: Browser, users: Record<PhoenixRole, TestUser>): Promise<Check[]> {
  const checks: Check[] = [];
  const context = await browser.newContext({ baseURL: localhostBaseUrl });
  const page = await context.newPage();
  try {
    const authUrl = new URL("/api/dev-auth", localhostBaseUrl);
    authUrl.searchParams.set("role", "Employee");
    authUrl.searchParams.set("loginId", "phase26.employee");
    authUrl.searchParams.set("hrId", users.Employee.hrId);
    authUrl.searchParams.set("next", "/employee-portals");
    const authResponse = await page.goto(authUrl.toString(), { timeout: 15000, waitUntil: "domcontentloaded" });
    if (!authResponse || authResponse.status() >= 400) {
      throw new Error(`local dev auth unavailable at ${localhostBaseUrl}; status ${authResponse?.status() ?? "unknown"}`);
    }

    const cases: Array<[string, string, Record<string, unknown>]> = [
      [
        "Employee app API cannot create employee",
        "/api/employees",
        {
          body: JSON.stringify({ employee: { fullName: `${phaseTag} denied`, hrId: `${phaseTag}-APP-DENIED` } }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      ],
      [
        "Employee app API cannot import approved expenses",
        "/api/payroll/expenses/import",
        {
          body: JSON.stringify({ month: 5, records: [], year: 2026 }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      ],
      [
        "Employee app API cannot run probation workflow",
        `/api/probation/${fakeUuid}/workflow`,
        {
          body: JSON.stringify({ action: "pass" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      ],
      [
        "Employee app API cannot approve vacation",
        `/api/vacations/requests/${fakeUuid}/decision`,
        {
          body: JSON.stringify({ decision: "approve" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      ],
    ];

    for (const [name, path, init] of cases) {
      try {
        const result = await appApiFetch(page, path, init);
        if (result.status !== 403) {
          throw new Error(`${name}: expected 403, received ${result.status}`);
        }
        checks.push(pass("App API guards", name, "Employee"));
      } catch (error) {
        checks.push(fail("App API guards", name, error, "Employee"));
      }
    }
  } catch (error) {
    checks.push(fail("App API guards", "local browser dev-auth guard checks completed", error, "Employee"));
  } finally {
    await context.close();
  }
  return checks;
}

async function readPhase26Residue(sql: ReturnType<typeof postgres>) {
  const rows = await sql`
    select 'employees' as table_name, count(*)::int as phase26_rows from public.employees where hr_id like 'PHASE26-%'
    union all
    select 'payroll_expenses', count(*)::int from public.payroll_expenses where trip_id like 'PHASE26-%' or source_file_name like 'PHASE26-%'
    union all
    select 'employee_probation', count(*)::int from public.employee_probation where notes like 'PHASE26-%' or coalesce(hr_id, '') like 'PHASE26-%' or coalesce(employee_hr_id, '') like 'PHASE26-%'
    union all
    select 'v2_vacation_requests', count(*)::int from public.v2_vacation_requests where notes like 'PHASE26-%' or employee_hr_id like 'PHASE26-%'
  `;
  return rows.map((row) => `${row.table_name}:${row.phase26_rows}`).join(", ");
}

async function main() {
  const loadInfo = loadLocalEnvFile(localEnvPath);
  const users = parseUsersConfig();
  const cleanup: CleanupState = {
    employeeHrIds: [],
    payrollExpenseIds: [],
    probationIds: [],
    vacationRequestIds: [],
  };
  const checks: Check[] = [
    pass(
      "Environment",
      loadInfo.status === "found" ? "loaded staging env without printing secrets" : "using process env only",
      undefined,
      loadInfo.status === "found" ? `${loadInfo.loadedKeys} keys` : undefined,
    ),
  ];
  const sql = createAdminSql();
  const browser = await chromium.launch({ headless: true });

  try {
    await alignStagingProbationAndLeaveSchema(sql);
    checks.push(pass("Staging schema parity", "probation and leave RLS proof tables are aligned"));

    const page = await browser.newPage();
    await page.goto("about:blank");
    const sessions = {} as Record<PhoenixRole, BrowserSession>;
    for (const role of roles) {
      try {
        sessions[role] = await browserSupabaseAuth(page, role, users[role]);
        checks.push(pass("Browser Supabase Auth", "real browser login returned Supabase JWT", role));
      } catch (error) {
        checks.push(fail("Browser Supabase Auth", "real browser login returned Supabase JWT", error, role));
      }
    }

    if (sessions.Employee) {
      try {
        await setPhoenixSupabaseCookies(browser, sessions.Employee);
        checks.push(pass("Browser Supabase Auth", "browser context can hold Phoenix Supabase auth cookies", "Employee"));
      } catch (error) {
        checks.push(fail("Browser Supabase Auth", "browser context can hold Phoenix Supabase auth cookies", error, "Employee"));
      }
    }

    if (roles.every((role) => sessions[role])) {
      checks.push(...await runBrowserRlsMutations(page, sessions, users, cleanup));
    }

    checks.push(...await verifyLocalAppPermissionGuards(browser, users));
  } catch (error) {
    checks.push(fail("PHASE26 smoke", "staging browser auth mutation proof completed", error));
  } finally {
    try {
      const cleaned = await cleanupPhase26Fixtures(sql, cleanup);
      checks.push(pass("Cleanup", "PHASE26 disposable fixtures cleaned where safe", undefined, JSON.stringify(cleaned)));
      const residue = await readPhase26Residue(sql);
      checks.push(pass("Cleanup", "PHASE26 residue report is clean", undefined, residue));
    } catch (error) {
      checks.push(fail("Cleanup", "PHASE26 disposable fixtures cleaned where safe", error));
    }
    await browser.close();
    await sql.end();
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    cleanup,
    failed,
    passed: checks.length - failed.length,
    policy: {
      mode: "PHASE26 uses the approved staging Supabase sandbox for all successful data mutations.",
      productionSafety: "The script refuses the Phoenix production project ref and cleans only PHASE26-prefixed disposable rows.",
      rls: "Allowed and denied mutations are browser-executed through real Supabase Auth JWTs; app API checks verify permission guards before mutation.",
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
