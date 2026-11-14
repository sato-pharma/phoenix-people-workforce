import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";

type PhoenixRole =
  | "Employee"
  | "Medical Rep"
  | "District Manager"
  | "Finance Manager"
  | "HR Operations"
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

type CleanupState = {
  employeeHrIds: string[];
  payrollExpenseIds: string[];
  probationIds: string[];
  vacationRequestIds: string[];
};

type SchemaAlignment = {
  createdOrAlignedTables: string[];
};

const localEnvPath = ".env.staging.rls.local";
const blockedProductionRef = "ozucdzovmcqvepbozvqf";
const phaseTag = `PHASE25-${Date.now()}`;

const roles: PhoenixRole[] = [
  "Super Admin",
  "HR Operations",
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

// This is the allowlist gate, so it carries no baked-in default. It used to fall back to the
// retired oaifhavixhdtwmseshff sandbox, which is no longer on the Supabase account: a missing
// setting therefore surfaced further down as a confusing "not the approved sandbox" refusal
// against a ref nobody recognises, instead of naming the actual problem here.
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
  const approvedRef = approvedStagingRef();
  if (hostname !== `${approvedRef}.supabase.co`) {
    throw new Error("Refusing any Supabase URL except the approved Phoenix RLS testing sandbox.");
  }
  return url;
}

function stagingDatabaseUrl() {
  const url = requiredEnv("PHOENIX_STAGING_DATABASE_URL");
  const parsed = new URL(url);
  const environment = requiredEnv("PHOENIX_STAGING_ENVIRONMENT").toLowerCase();
  if (url.includes(blockedProductionRef) || parsed.hostname.includes(blockedProductionRef)) {
    throw new Error("Refusing Phoenix production database URL.");
  }
  const approvedRef = approvedStagingRef();
  if (!url.includes(approvedRef) && !parsed.hostname.includes(approvedRef)) {
    throw new Error("Refusing any database URL except the approved Phoenix RLS testing sandbox.");
  }
  if (environment.includes("production")) {
    throw new Error("Refusing production environment for Phase 25 staging mutation proof.");
  }
  return url;
}

function parseUsersConfig(): Record<PhoenixRole, TestUser> {
  const parsed = JSON.parse(requiredEnv("PHOENIX_RLS_TEST_USERS_JSON")) as Partial<Record<PhoenixRole, TestUser>>;
  const missing = roles.filter((role) => !parsed[role]?.hrId || !parsed[role]?.loginId || !parsed[role]?.password);
  if (missing.length > 0) {
    throw new Error(`PHOENIX_RLS_TEST_USERS_JSON is missing Phase 25 roles: ${missing.join(", ")}`);
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

function createAdminSql() {
  return postgres(stagingDatabaseUrl(), {
    max: 1,
    prepare: false,
    ssl: "require",
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

function assertAllowed(error: { message?: string } | null, label: string) {
  if (error) throw new Error(`${label}: expected allowed, received ${error.message ?? "unknown error"}`);
}

function assertDenied(error: { message?: string } | null, rows: unknown[] | null | undefined, label: string) {
  if (!error && (rows?.length ?? 0) > 0) {
    throw new Error(`${label}: expected denied or zero affected rows, affected ${rows?.length ?? 0}`);
  }
}

async function alignStagingProbationAndLeaveSchema(sql: ReturnType<typeof postgres>): Promise<SchemaAlignment> {
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

    update public.employee_probation
      set employee_hr_id = hr_id
      where employee_hr_id is null and hr_id is not null;

    create index if not exists employee_probation_employee_hr_id_idx
      on public.employee_probation (employee_hr_id);
    create index if not exists employee_probation_manager_hr_id_idx
      on public.employee_probation (manager_hr_id);
    create index if not exists employee_probation_end_date_idx
      on public.employee_probation (probation_end_date);

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

    create index if not exists v2_vacation_requests_employee_idx
      on public.v2_vacation_requests (employee_hr_id, start_date desc);
    create index if not exists v2_vacation_requests_manager_idx
      on public.v2_vacation_requests (manager_hr_id, status, created_at desc);

    alter table public.employee_probation enable row level security;
    alter table public.v2_vacation_requests enable row level security;

    revoke all on table public.employee_probation from public, anon;
    revoke all on table public.v2_vacation_requests from public, anon;
    grant select, insert, update, delete on table public.employee_probation to authenticated, service_role;
    grant select, insert, update, delete on table public.v2_vacation_requests to authenticated, service_role;

    drop policy if exists phase25_employee_probation_select_access on public.employee_probation;
    drop policy if exists phase25_employee_probation_insert_access on public.employee_probation;
    drop policy if exists phase25_employee_probation_update_access on public.employee_probation;
    drop policy if exists phase25_employee_probation_delete_access on public.employee_probation;

    create policy phase25_employee_probation_select_access
      on public.employee_probation
      for select
      to authenticated
      using (
        public.current_access_can_manage_employees()
        or public.current_access_can_see_employee(employee_hr_id, manager_hr_id)
      );

    create policy phase25_employee_probation_insert_access
      on public.employee_probation
      for insert
      to authenticated
      with check (public.current_access_can_manage_employees());

    create policy phase25_employee_probation_update_access
      on public.employee_probation
      for update
      to authenticated
      using (public.current_access_can_manage_employees())
      with check (public.current_access_can_manage_employees());

    create policy phase25_employee_probation_delete_access
      on public.employee_probation
      for delete
      to authenticated
      using (public.current_access_can_manage_employees());

    drop policy if exists phase25_v2_vacation_requests_select_access on public.v2_vacation_requests;
    drop policy if exists phase25_v2_vacation_requests_insert_access on public.v2_vacation_requests;
    drop policy if exists phase25_v2_vacation_requests_update_access on public.v2_vacation_requests;
    drop policy if exists phase25_v2_vacation_requests_delete_access on public.v2_vacation_requests;

    create policy phase25_v2_vacation_requests_select_access
      on public.v2_vacation_requests
      for select
      to authenticated
      using (
        public.current_access_can_manage_employees()
        or public.current_access_can_manage_payroll()
        or public.current_access_can_see_employee(employee_hr_id, manager_hr_id)
      );

    create policy phase25_v2_vacation_requests_insert_access
      on public.v2_vacation_requests
      for insert
      to authenticated
      with check (
        public.current_access_can_manage_employees()
        or lower(coalesce(employee_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
      );

    create policy phase25_v2_vacation_requests_update_access
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

    create policy phase25_v2_vacation_requests_delete_access
      on public.v2_vacation_requests
      for delete
      to authenticated
      using (public.current_access_can_manage_employees());

    notify pgrst, 'reload schema';
  `);

  return { createdOrAlignedTables: ["employee_probation", "v2_vacation_requests"] };
}

async function cleanupPhase25Fixtures(sql: ReturnType<typeof postgres>) {
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
      delete from public.outstation_expenses
      where source_file_name = ${`${phaseTag}_RLS_MUTATION_SMOKE`}
        or trip_id like ${`${phaseTag}%`}
    `;
    await transaction`
      delete from public.employees
      where hr_id like ${`${phaseTag}-%`}
    `;
  });
}

async function verifyEmployeeMutations(
  clients: Record<PhoenixRole, SupabaseClient>,
  users: Record<PhoenixRole, TestUser>,
  cleanup: CleanupState,
): Promise<Check[]> {
  const checks: Check[] = [];
  const hrFixture = `${phaseTag}-HR-GOV`;
  const superFixture = `${phaseTag}-SA-GOV`;

  try {
    const { data, error } = await clients["Employee"]
      .from("employees")
      .insert({
        employment_status: "active",
        full_name: `${phaseTag} Unauthorized Employee`,
        hire_date: "2026-05-19",
        hr_id: `${phaseTag}-EMP-DENIED`,
        job_title: "PHASE25 Unauthorized Fixture",
        manager_hr_id: users["District Manager"].hrId,
      })
      .select("hr_id");
    assertDenied(error, data, "employee self-only employee creation");
    checks.push(pass("Employees RLS", "Employee cannot create employee master rows", "Employee"));
  } catch (error) {
    checks.push(fail("Employees RLS", "Employee cannot create employee master rows", error, "Employee"));
  }

  try {
    const { data, error } = await clients["HR Operations"]
      .from("employees")
      .insert({
        employment_status: "active",
        full_name: `${phaseTag} HR Governance Fixture`,
        hire_date: "2026-05-19",
        hr_id: hrFixture,
        job_title: "PHASE25 HR Governance Fixture",
        manager_hr_id: users["HR Operations"].hrId,
      })
      .select("hr_id")
      .maybeSingle();
    assertAllowed(error, "HR employee governance insert");
    if (!data?.hr_id) throw new Error("HR employee governance insert returned no fixture");
    cleanup.employeeHrIds.push(hrFixture);
    checks.push(pass("Employees RLS", "HR can create disposable employee governance fixture", "HR Operations"));
  } catch (error) {
    checks.push(fail("Employees RLS", "HR can create disposable employee governance fixture", error, "HR Operations"));
  }

  try {
    const { data, error } = await clients["Super Admin"]
      .from("employees")
      .insert({
        employment_status: "active",
        full_name: `${phaseTag} Super Admin Governance Fixture`,
        hire_date: "2026-05-19",
        hr_id: superFixture,
        job_title: "PHASE25 Super Admin Governance Fixture",
        manager_hr_id: users["Super Admin"].hrId,
      })
      .select("hr_id")
      .maybeSingle();
    assertAllowed(error, "Super Admin employee governance insert");
    if (!data?.hr_id) throw new Error("Super Admin employee governance insert returned no fixture");
    cleanup.employeeHrIds.push(superFixture);
    checks.push(pass("Employees RLS", "Super Admin can create disposable employee governance fixture", "Super Admin"));
  } catch (error) {
    checks.push(fail("Employees RLS", "Super Admin can create disposable employee governance fixture", error, "Super Admin"));
  }

  try {
    const { data, error } = await clients["District Manager"]
      .from("employees")
      .update({ job_title: "PHASE25 Unauthorized Manager Update" })
      .eq("hr_id", hrFixture)
      .select("hr_id");
    assertDenied(error, data, "manager outside-team employee governance update");
    checks.push(pass("Employees RLS", "Manager cannot mutate employee governance outside team", "District Manager"));
  } catch (error) {
    checks.push(fail("Employees RLS", "Manager cannot mutate employee governance outside team", error, "District Manager"));
  }

  return checks;
}

async function verifyFinanceMutations(
  clients: Record<PhoenixRole, SupabaseClient>,
  users: Record<PhoenixRole, TestUser>,
  cleanup: CleanupState,
): Promise<Check[]> {
  const checks: Check[] = [];
  let expenseId: string | undefined;

  try {
    const { data, error } = await clients["Finance Manager"]
      .from("outstation_expenses")
      .insert({
        description: `${phaseTag} finance disposable expense`,
        expense_date: "2026-05-19",
        from_location: "PHASE25",
        hr_id: users["Finance Manager"].hrId,
        request_type: "PHASE25",
        source_file_name: `${phaseTag}_RLS_MUTATION_SMOKE`,
        source_row: 25,
        specialist: `${phaseTag} Finance Fixture`,
        status: "PHASE25",
        to_location: "PHASE25",
        total: 25,
        travel_cost: 25,
        trip_id: `${phaseTag}-EXPENSE`,
      })
      .select("id")
      .maybeSingle();
    assertAllowed(error, "Finance payroll expense insert");
    if (!data?.id) throw new Error("Finance payroll expense insert returned no fixture id");
    expenseId = String(data.id);
    cleanup.payrollExpenseIds.push(expenseId);
    checks.push(pass("Expenses RLS", "Finance can create disposable payroll expense fixture", "Finance Manager"));
  } catch (error) {
    checks.push(fail("Expenses RLS", "Finance can create disposable payroll expense fixture", error, "Finance Manager"));
  }

  if (expenseId) {
    try {
      const { data, error } = await clients["Employee"]
        .from("outstation_expenses")
        .update({ total: 999 })
        .eq("id", expenseId)
        .select("id");
      assertDenied(error, data, "employee payroll expense update");
      checks.push(pass("Expenses RLS", "Employee cannot mutate payroll expense fixtures", "Employee"));
    } catch (error) {
      checks.push(fail("Expenses RLS", "Employee cannot mutate payroll expense fixtures", error, "Employee"));
    }

    try {
      const { data, error } = await clients["Finance Manager"]
        .from("outstation_expenses")
        .update({ hr_comment: `${phaseTag} finance update accepted` })
        .eq("id", expenseId)
        .select("id");
      assertAllowed(error, "Finance payroll expense update");
      if ((data?.length ?? 0) !== 1) throw new Error("Finance payroll expense update affected no rows");
      checks.push(pass("Expenses RLS", "Finance can update disposable payroll expense fixture", "Finance Manager"));
    } catch (error) {
      checks.push(fail("Expenses RLS", "Finance can update disposable payroll expense fixture", error, "Finance Manager"));
    }
  }

  return checks;
}

async function verifyProbationAndLeaveMutations(
  clients: Record<PhoenixRole, SupabaseClient>,
  users: Record<PhoenixRole, TestUser>,
  cleanup: CleanupState,
): Promise<Check[]> {
  const checks: Check[] = [];
  let probationId: string | undefined;
  let vacationRequestId: string | undefined;
  let managerVacationRequestId: string | undefined;

  try {
    const { data, error } = await clients["HR Operations"]
      .from("employee_probation")
      .insert({
        employee_hr_id: users["Employee"].hrId,
        hr_id: users["Employee"].hrId,
        manager_hr_id: users["HR Operations"].hrId,
        notes: `${phaseTag} HR probation fixture`,
        probation_end_date: "2026-06-18",
        probation_start_date: "2026-05-19",
        status: "active",
      })
      .select("id")
      .maybeSingle();
    assertAllowed(error, "HR probation insert");
    if (!data?.id) throw new Error("HR probation insert returned no fixture id");
    probationId = String(data.id);
    cleanup.probationIds.push(probationId);
    checks.push(pass("Probation RLS", "HR can create disposable probation fixture", "HR Operations"));
  } catch (error) {
    checks.push(fail("Probation RLS", "HR can create disposable probation fixture", error, "HR Operations"));
  }

  if (probationId) {
    try {
      const { data, error } = await clients["Employee"]
        .from("employee_probation")
        .update({ status: "confirmed" })
        .eq("id", probationId)
        .select("id");
      assertDenied(error, data, "employee probation update");
      checks.push(pass("Probation RLS", "Employee cannot self-mutate probation decisions", "Employee"));
    } catch (error) {
      checks.push(fail("Probation RLS", "Employee cannot self-mutate probation decisions", error, "Employee"));
    }

    try {
      const { data, error } = await clients["District Manager"]
        .from("employee_probation")
        .update({ status: "terminated" })
        .eq("id", probationId)
        .select("id");
      assertDenied(error, data, "manager outside-team probation update");
      checks.push(pass("Probation RLS", "Manager cannot mutate probation outside team/scope", "District Manager"));
    } catch (error) {
      checks.push(fail("Probation RLS", "Manager cannot mutate probation outside team/scope", error, "District Manager"));
    }
  }

  try {
    const { data, error } = await clients["Employee"]
      .from("v2_vacation_requests")
      .insert({
        calendar_days: 1,
        employee_hr_id: users["Employee"].hrId,
        end_date: "2026-05-20",
        manager_hr_id: users["District Manager"].hrId,
        notes: `${phaseTag} employee leave fixture`,
        start_date: "2026-05-20",
        status: "pending",
        vacation_type: "annual",
        working_days: 1,
      })
      .select("id")
      .maybeSingle();
    assertAllowed(error, "Employee own vacation request insert");
    if (!data?.id) throw new Error("Employee vacation request insert returned no fixture id");
    vacationRequestId = String(data.id);
    cleanup.vacationRequestIds.push(vacationRequestId);
    checks.push(pass("Leave RLS", "Employee can create own disposable vacation request", "Employee"));
  } catch (error) {
    checks.push(fail("Leave RLS", "Employee can create own disposable vacation request", error, "Employee"));
  }

  try {
    const { data, error } = await clients["Employee"]
      .from("v2_vacation_requests")
      .insert({
        calendar_days: 1,
        employee_hr_id: users["Medical Rep"].hrId,
        end_date: "2026-05-21",
        manager_hr_id: users["District Manager"].hrId,
        notes: `${phaseTag} unauthorized leave fixture`,
        start_date: "2026-05-21",
        status: "pending",
        vacation_type: "annual",
        working_days: 1,
      })
      .select("id");
    assertDenied(error, data, "Employee vacation request insert for another employee");
    checks.push(pass("Leave RLS", "Employee cannot create vacation request for another employee", "Employee"));
  } catch (error) {
    checks.push(fail("Leave RLS", "Employee cannot create vacation request for another employee", error, "Employee"));
  }

  try {
    const { data, error } = await clients["HR Operations"]
      .from("v2_vacation_requests")
      .insert({
        calendar_days: 1,
        employee_hr_id: users["HR Operations"].hrId,
        end_date: "2026-05-22",
        manager_hr_id: users["HR Operations"].hrId,
        notes: `${phaseTag} outside manager leave fixture`,
        start_date: "2026-05-22",
        status: "pending",
        vacation_type: "annual",
        working_days: 1,
      })
      .select("id")
      .maybeSingle();
    assertAllowed(error, "HR outside-manager leave fixture insert");
    if (!data?.id) throw new Error("HR outside-manager leave fixture insert returned no fixture id");
    managerVacationRequestId = String(data.id);
    cleanup.vacationRequestIds.push(managerVacationRequestId);
    checks.push(pass("Leave RLS", "HR can create disposable outside-manager leave fixture", "HR Operations"));
  } catch (error) {
    checks.push(fail("Leave RLS", "HR can create disposable outside-manager leave fixture", error, "HR Operations"));
  }

  if (managerVacationRequestId) {
    try {
      const { data, error } = await clients["District Manager"]
        .from("v2_vacation_requests")
        .update({ status: "approved" })
        .eq("id", managerVacationRequestId)
        .select("id");
      assertDenied(error, data, "manager outside-team vacation update");
      checks.push(pass("Leave RLS", "Manager cannot mutate vacation requests outside team", "District Manager"));
    } catch (error) {
      checks.push(fail("Leave RLS", "Manager cannot mutate vacation requests outside team", error, "District Manager"));
    }
  }

  return checks;
}

async function verifyServiceRoleGuardSources(): Promise<Check[]> {
  const checks: Check[] = [];
  const expectations: Array<[string, string, RegExp[]]> = [
    ["app/api/vacations/requests/[id]/decision/route.ts", "vacation decision route", [/resolveAccessContext\(request\)/, /decideVacationRequest\(access/]],
    ["src/lib/vacation/service.ts", "vacation decision service", [/assertPermission\(access, "leave", "approve"\)/]],
    ["app/api/admin/outstation/expenses/import/route.ts", "approved expense import route", [/resolveAccessContext\(request\)/, /assertSystemAdministratorWorkspaceAccess\(access,\s*"payroll expenses administration"\)/]],
    ["app/api/employees/route.ts", "employee mutation route", [/resolveAccessContext\(request\)/, /assertPermission\(access, "employees", "update"\)/]],
    ["app/api/probation/cases/[caseId]/decision/route.ts", "probation case decision route", [/resolveAccessContext\(request\)/, /assertPermission\(access, "probation"/]],
  ];

  for (const [path, label, patterns] of expectations) {
    try {
      const source = readFileSync(path, "utf8");
      const missing = patterns.filter((pattern) => !pattern.test(source));
      if (missing.length > 0) {
        throw new Error(`${label} is missing guard(s): ${missing.map(String).join(", ")}`);
      }
      checks.push(pass("API guards", `${label} keeps explicit permission guard`));
    } catch (error) {
      checks.push(fail("API guards", `${label} keeps explicit permission guard`, error));
    }
  }

  return checks;
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
  const clients = {} as Record<PhoenixRole, SupabaseClient>;

  try {
    const alignment = await alignStagingProbationAndLeaveSchema(sql);
    checks.push(pass("Staging schema parity", "probation and leave RLS proof tables are aligned", undefined, alignment.createdOrAlignedTables.join(", ")));

    for (const role of roles) {
      clients[role] = await signIn(role, users[role]);
    }

    checks.push(...await verifyEmployeeMutations(clients, users, cleanup));
    checks.push(...await verifyFinanceMutations(clients, users, cleanup));
    checks.push(...await verifyProbationAndLeaveMutations(clients, users, cleanup));
    checks.push(...await verifyServiceRoleGuardSources());
  } catch (error) {
    checks.push(fail("PHASE25 smoke", "staging RLS mutation proof completed", error));
  } finally {
    try {
      await cleanupPhase25Fixtures(sql);
      checks.push(pass(
        "Cleanup",
        "PHASE25 disposable fixtures cleaned where safe",
        undefined,
        `${cleanup.employeeHrIds.length} employees, ${cleanup.payrollExpenseIds.length} expenses, ${cleanup.probationIds.length} probation rows, ${cleanup.vacationRequestIds.length} vacation rows`,
      ));
    } catch (error) {
      checks.push(fail("Cleanup", "PHASE25 disposable fixtures cleaned where safe", error));
    }

    for (const role of roles) {
      if (clients[role]) {
        await clients[role].auth.signOut();
      }
    }
    await sql.end();
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    cleanup: {
      disposablePattern: phaseTag,
      tracked: cleanup,
    },
    failed,
    passed: checks.length - failed.length,
    policy: {
      mode: "PHASE25 uses the approved staging Supabase sandbox only and PHASE25 disposable fixtures only.",
      productionSafety: "The script refuses the Phoenix production project ref and cleans only PHASE25-prefixed disposable rows.",
      rls: "Denied and allowed writes are executed through real Supabase Auth JWTs; service-role app routes remain guarded by Phoenix permissions.",
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
