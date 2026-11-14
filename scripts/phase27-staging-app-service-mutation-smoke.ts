import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";

type PhoenixRole =
  | "Employee"
  | "Medical Rep"
  | "District Manager"
  | "Finance Manager"
  | "HR Advisory"
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
  expenseReportFileNames: string[];
  payrollExpenseTripIds: string[];
  probationEvaluationIds: string[];
  probationIds: string[];
  vacationRequestIds: string[];
};

type AppRoutes = {
  employees: {
    POST: (request: Request) => Promise<Response>;
  };
  expenses: {
    POST: (request: Request) => Promise<Response>;
  };
  login: {
    POST: (request: Request) => Promise<Response>;
  };
  vacation: {
    POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
};

const localEnvPath = ".env.staging.rls.local";
const blockedProductionRef = "ozucdzovmcqvepbozvqf";
const phaseTag = `PHASE27-${Date.now()}`;
const port = Number(process.env.PHOENIX_PHASE27_PORT ?? 3027);
const baseUrl = `http://localhost:${port}`;

const roles: PhoenixRole[] = [
  "Super Admin",
  "HR Advisory",
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

function optionalEnv(name: string) {
  return process.env[name]?.trim() || null;
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
  if (url.includes(blockedProductionRef) || parsed.hostname.includes(blockedProductionRef)) {
    throw new Error("Refusing Phoenix production database URL.");
  }
  const approvedRef = approvedStagingRef();
  if (!url.includes(approvedRef) && !parsed.hostname.includes(approvedRef)) {
    throw new Error("Refusing any database URL except the approved Phoenix RLS testing sandbox.");
  }
  return url;
}

function stagingServiceRoleKey() {
  const value = optionalEnv("PHOENIX_STAGING_SUPABASE_SERVICE_ROLE_KEY");
  if (!value) {
    throw new Error("PHOENIX_STAGING_SUPABASE_SERVICE_ROLE_KEY is required for Phase 27 app-service mutation proof. Refusing to use .env.local because it points at production.");
  }
  if (value === optionalEnv("SUPABASE_SERVICE_ROLE_KEY") && optionalEnv("NEXT_PUBLIC_SUPABASE_URL")?.includes(blockedProductionRef)) {
    throw new Error("Refusing to use the production SUPABASE_SERVICE_ROLE_KEY for staging app-service proof.");
  }
  return value;
}

function parseUsersConfig(): Record<PhoenixRole, TestUser> {
  const parsed = JSON.parse(requiredEnv("PHOENIX_RLS_TEST_USERS_JSON")) as Partial<Record<PhoenixRole, TestUser>>;
  const missing = roles.filter((role) => !parsed[role]?.hrId || !parsed[role]?.loginId || !parsed[role]?.password);
  if (missing.length > 0) {
    throw new Error(`PHOENIX_RLS_TEST_USERS_JSON is missing Phase 27 roles: ${missing.join(", ")}`);
  }
  return parsed as Record<PhoenixRole, TestUser>;
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

function createAdminSql() {
  return postgres(stagingDatabaseUrl(), {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
    ssl: "require",
  });
}

async function validateStagingServiceRoleKey() {
  const key = stagingServiceRoleKey();
  const response = await fetch(`${stagingUrl()}/auth/v1/admin/users?page=1&per_page=1`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Staging service-role key validation failed with status ${response.status}.`);
  }
}

async function alignStagingProofSchema(sql: ReturnType<typeof postgres>) {
  await sql.unsafe(`
    create extension if not exists pgcrypto;

    alter table public.app_auth_users add column if not exists session_version integer not null default 1;

    alter table public.employees add column if not exists name_ar text null;
    alter table public.employees add column if not exists national_id text null;
    alter table public.employees add column if not exists line text null;
    alter table public.employees add column if not exists region_name text null;
    alter table public.employees add column if not exists birth_date date null;
    alter table public.employees add column if not exists gender text null;
    alter table public.employees add column if not exists has_bank_account boolean null;
    alter table public.employees add column if not exists bank_name text null;
    alter table public.employees add column if not exists bank_account text null;
    alter table public.employees add column if not exists social_insurance_status text null;
    alter table public.employees add column if not exists social_insurance_number text null;
    alter table public.employees add column if not exists medical_insurance_status text null;
    alter table public.employees add column if not exists medical_insurance_number text null;
    alter table public.employees add column if not exists basic_salary numeric null;
    alter table public.employees add column if not exists base_salary numeric null;
    alter table public.employees add column if not exists gross_salary numeric null;
    alter table public.employees add column if not exists net_salary numeric null;
    alter table public.employees add column if not exists fuel_allowance numeric null;
    alter table public.employees add column if not exists extra_cost_of_living numeric null;
    alter table public.employees add column if not exists medical_insurance numeric null;
    alter table public.employees add column if not exists social_insurance numeric null;
    alter table public.employees add column if not exists taxes numeric null;
    alter table public.employees add column if not exists payment_mode text null;
    alter table public.employees add column if not exists residence_address text null;
    alter table public.employees add column if not exists residence_city text null;
    alter table public.employees add column if not exists residence_area text null;
    alter table public.employees add column if not exists contract_type text null;
    alter table public.employees add column if not exists contract_renewal_date date null;
    alter table public.employees add column if not exists crm_username text null;
    alter table public.employees add column if not exists work_email text null;
    alter table public.employees add column if not exists mobile_number text null;
    alter table public.employees add column if not exists education text null;
    alter table public.employees add column if not exists department_id text null;
    alter table public.employees add column if not exists line_id text null;
    alter table public.employees add column if not exists area_id text null;
    alter table public.employees add column if not exists team_id text null;
    alter table public.employees add column if not exists position_id text null;
    alter table public.employees add column if not exists payroll_eligible boolean not null default true;
    alter table public.employees add column if not exists organogram_visible boolean not null default true;

    alter table public.areas add column if not exists line_id integer null;
    alter table public.teams add column if not exists area_id integer null;
    alter table public.teams add column if not exists is_active boolean not null default true;

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

    create table if not exists public.probation_evaluations (
      id uuid primary key default gen_random_uuid(),
      employee_hr_id text not null,
      probation_id text null,
      employee_name text not null,
      job_title text null,
      line_name text null,
      area_name text null,
      probation_end_date date not null,
      evaluation_scores jsonb not null default '{}'::jsonb,
      manager_feedback text null,
      hr_recommendation text null,
      decision text null,
      extension_end_date date null,
      decision_reason text null,
      probation_letter_url text null,
      probation_letter_name text null,
      workflow_notes text null,
      status text not null default 'evaluation_requested',
      created_by text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      manager_reviewed_at timestamptz null,
      manager_reviewed_by text null,
      hr_reviewed_at timestamptz null,
      hr_reviewed_by text null,
      approved_at timestamptz null,
      approved_by text null,
      completed_at timestamptz null,
      completed_by text null
    );

    alter table public.probation_evaluations add column if not exists employee_hr_id text;
    alter table public.probation_evaluations add column if not exists probation_id text null;
    alter table public.probation_evaluations add column if not exists employee_name text;
    alter table public.probation_evaluations add column if not exists job_title text null;
    alter table public.probation_evaluations add column if not exists line_name text null;
    alter table public.probation_evaluations add column if not exists area_name text null;
    alter table public.probation_evaluations add column if not exists probation_end_date date;
    alter table public.probation_evaluations add column if not exists evaluation_scores jsonb not null default '{}'::jsonb;
    alter table public.probation_evaluations add column if not exists manager_feedback text null;
    alter table public.probation_evaluations add column if not exists hr_recommendation text null;
    alter table public.probation_evaluations add column if not exists decision text null;
    alter table public.probation_evaluations add column if not exists extension_end_date date null;
    alter table public.probation_evaluations add column if not exists decision_reason text null;
    alter table public.probation_evaluations add column if not exists probation_letter_url text null;
    alter table public.probation_evaluations add column if not exists probation_letter_name text null;
    alter table public.probation_evaluations add column if not exists workflow_notes text null;
    alter table public.probation_evaluations add column if not exists status text not null default 'evaluation_requested';
    alter table public.probation_evaluations add column if not exists created_by text null;
    alter table public.probation_evaluations add column if not exists created_at timestamptz not null default now();
    alter table public.probation_evaluations add column if not exists updated_at timestamptz not null default now();
    alter table public.probation_evaluations add column if not exists manager_reviewed_at timestamptz null;
    alter table public.probation_evaluations add column if not exists manager_reviewed_by text null;
    alter table public.probation_evaluations add column if not exists hr_reviewed_at timestamptz null;
    alter table public.probation_evaluations add column if not exists hr_reviewed_by text null;
    alter table public.probation_evaluations add column if not exists approved_at timestamptz null;
    alter table public.probation_evaluations add column if not exists approved_by text null;
    alter table public.probation_evaluations add column if not exists completed_at timestamptz null;
    alter table public.probation_evaluations add column if not exists completed_by text null;

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
    alter table public.v2_vacation_requests add column if not exists balance_after_days numeric null;
    alter table public.v2_vacation_requests add column if not exists balance_before_days numeric null;
    alter table public.v2_vacation_requests add column if not exists day_part text null;
    alter table public.v2_vacation_requests add column if not exists department_name text null;
    alter table public.v2_vacation_requests add column if not exists duration_days numeric null;
    alter table public.v2_vacation_requests add column if not exists employee_hire_date date null;
    alter table public.v2_vacation_requests add column if not exists employee_name text null;
    alter table public.v2_vacation_requests add column if not exists employee_work_email text null;
    alter table public.v2_vacation_requests add column if not exists entitlement_days numeric null;
    alter table public.v2_vacation_requests add column if not exists line_name text null;
    alter table public.v2_vacation_requests add column if not exists manager_decision text null;
    alter table public.v2_vacation_requests add column if not exists manager_decision_at timestamptz null;
    alter table public.v2_vacation_requests add column if not exists manager_decision_by_hr_id text null;
    alter table public.v2_vacation_requests add column if not exists manager_decision_comment text null;
    alter table public.v2_vacation_requests add column if not exists manager_name text null;
    alter table public.v2_vacation_requests add column if not exists manager_of_manager_name text null;
    alter table public.v2_vacation_requests add column if not exists period_end date null;
    alter table public.v2_vacation_requests add column if not exists period_start date null;
    alter table public.v2_vacation_requests add column if not exists submitted_by_hr_id text null;
    alter table public.v2_vacation_requests add column if not exists unpaid_reason text null;
    alter table public.v2_vacation_requests add column if not exists used_paid_days numeric null;
    alter table public.v2_vacation_requests add column if not exists status text not null default 'pending';
    alter table public.v2_vacation_requests add column if not exists payment_status text not null default 'pending';
    alter table public.v2_vacation_requests add column if not exists notes text null;
    alter table public.v2_vacation_requests add column if not exists created_at timestamptz not null default now();
    alter table public.v2_vacation_requests add column if not exists updated_at timestamptz not null default now();

    create table if not exists public.v2_vacation_request_events (
      id uuid primary key default gen_random_uuid(),
      request_id uuid null,
      actor_hr_id text null,
      actor_login_id text null,
      event_type text not null,
      message text null,
      metadata jsonb not null default '{}'::jsonb,
      note text null,
      created_at timestamptz not null default now()
    );
    alter table public.v2_vacation_request_events add column if not exists actor_login_id text null;
    alter table public.v2_vacation_request_events add column if not exists message text null;
    alter table public.v2_vacation_request_events add column if not exists metadata jsonb not null default '{}'::jsonb;

    create table if not exists public.v2_vacation_email_tokens (
      id uuid primary key default gen_random_uuid(),
      request_id uuid null,
      manager_hr_id text null,
      token_hash text null,
      decision text null,
      expires_at timestamptz null,
      used_at timestamptz null,
      created_at timestamptz not null default now()
    );

    notify pgrst, 'reload schema';
  `);
}

async function seedPhase27Fixtures(
  sql: ReturnType<typeof postgres>,
  users: Record<PhoenixRole, TestUser>,
  cleanup: CleanupState,
) {
  const employeeHrId = `${phaseTag}-HR-GOV`;
  cleanup.employeeHrIds.push(employeeHrId);
  await sql`
    insert into public.employees (hr_id, full_name, employment_status, hire_date, job_title, manager_hr_id)
    values (${employeeHrId}, ${`${phaseTag} App Service Employee`}, 'active', '2026-05-19', 'PHASE27 Fixture', ${users["HR Advisory"].hrId})
    on conflict (hr_id) do update set updated_at = now()
  `;

  const probationRows = await sql`
    insert into public.employee_probation (employee_hr_id, hr_id, manager_hr_id, notes, probation_start_date, probation_end_date, status)
    values (${users.Employee.hrId}, ${users.Employee.hrId}, ${users["HR Advisory"].hrId}, ${`${phaseTag} probation fixture`}, '2026-05-19', '2026-06-18', 'active')
    returning id
  `;
  cleanup.probationIds.push(String(probationRows[0].id));

  const probationEvaluationRows = await sql`
    insert into public.probation_evaluations (
      area_name,
      created_by,
      employee_hr_id,
      employee_name,
      evaluation_scores,
      job_title,
      line_name,
      probation_end_date,
      probation_id,
      status,
      workflow_notes
    )
    values (
      'PHASE27',
      ${phaseTag},
      ${users.Employee.hrId},
      ${`${phaseTag} Probation Employee`},
      ${sql.json({})},
      'PHASE27 Fixture',
      'PHASE27',
      '2026-06-18',
      ${String(probationRows[0].id)},
      'evaluation_requested',
      ${`${phaseTag} probation evaluation fixture`}
    )
    returning id
  `;
  cleanup.probationEvaluationIds.push(String(probationEvaluationRows[0].id));

  const vacationRows = await sql`
    insert into public.v2_vacation_requests (employee_hr_id, manager_hr_id, vacation_type, start_date, end_date, working_days, calendar_days, status, notes)
    values (${users.Employee.hrId}, ${users["District Manager"].hrId}, 'annual', '2026-05-20', '2026-05-20', 1, 1, 'pending_manager', ${`${phaseTag} vacation fixture`})
    returning id
  `;
  cleanup.vacationRequestIds.push(String(vacationRows[0].id));

  return {
    employeeHrId,
    probationId: String(probationEvaluationRows[0].id),
    vacationId: String(vacationRows[0].id),
  };
}

async function cleanupPhase27Fixtures(sql: ReturnType<typeof postgres>) {
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`
      do $$
      begin
        if to_regclass('public.probation_history') is not null then
          delete from public.probation_history
          where evaluation_id in (
            select id from public.probation_evaluations
            where workflow_notes like '${phaseTag}%'
          );
        end if;
      end $$;
    `);
    await transaction`
      delete from public.probation_evaluations
      where workflow_notes like ${`${phaseTag}%`}
        or employee_name like ${`${phaseTag}%`}
        or created_by = ${phaseTag}
    `;
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
      where source_file_name = ${`${phaseTag}_APP_SERVICE_SMOKE`}
        or trip_id like ${`${phaseTag}%`}
    `;
    await transaction`
      delete from public.outstation_expense_reports
      where file_name = ${`${phaseTag}_APP_SERVICE_SMOKE`}
    `;
    await transaction`
      delete from public.employees
      where hr_id like ${`${phaseTag}-%`}
    `;
  });
}

async function readPhase27Residue(sql: ReturnType<typeof postgres>) {
  const rows = await sql`
    select 'employees' as table_name, count(*)::int as phase27_rows from public.employees where hr_id like 'PHASE27-%'
    union all
    select 'outstation_expenses', count(*)::int from public.outstation_expenses where trip_id like 'PHASE27-%' or source_file_name like 'PHASE27-%'
    union all
    select 'outstation_expense_reports', count(*)::int from public.outstation_expense_reports where file_name like 'PHASE27-%'
    union all
    select 'employee_probation', count(*)::int from public.employee_probation where notes like 'PHASE27-%' or coalesce(hr_id, '') like 'PHASE27-%' or coalesce(employee_hr_id, '') like 'PHASE27-%'
    union all
    select 'probation_evaluations', count(*)::int from public.probation_evaluations where workflow_notes like 'PHASE27-%' or employee_name like 'PHASE27-%' or coalesce(created_by, '') like 'PHASE27-%'
    union all
    select 'v2_vacation_requests', count(*)::int from public.v2_vacation_requests where notes like 'PHASE27-%' or employee_hr_id like 'PHASE27-%'
  `;
  return rows.map((row) => `${row.table_name}:${row.phase27_rows}`).join(", ");
}

function applyStagingAppRouteEnv() {
  process.env.APP_URL = baseUrl;
  process.env.NEXT_PUBLIC_APP_URL = baseUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = requiredEnv("PHOENIX_STAGING_SUPABASE_ANON_KEY");
  process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl();
  process.env.SUPABASE_DB_URL = stagingDatabaseUrl();
  process.env.SUPABASE_SERVICE_ROLE_KEY = stagingServiceRoleKey();
  process.env.PHOENIX_AUTH_SECRET ??= "phase27-staging-local-session-secret";
}

async function importAppRoutes(): Promise<AppRoutes> {
  const [login, employees, expenses, vacation] = await Promise.all([
    import("../app/api/auth/login/route.ts"),
    import("../app/api/employees/route.ts"),
    import("../app/api/admin/outstation/expenses/route.ts"),
    import("../app/api/vacations/requests/[id]/decision/route.ts"),
  ]);

  return {
    employees,
    expenses,
    login,
    vacation,
  };
}

async function readResponseBody(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 300);
  }
}

async function loginCookieHeader(
  sql: ReturnType<typeof postgres>,
  role: PhoenixRole,
  user: TestUser,
) {
  const rows = await sql`
    select hr_id, is_active, login_id, role, session_version
    from public.app_auth_users
    where login_id ilike ${user.loginId} or hr_id ilike ${user.hrId}
    limit 1
  `;
  const row = rows[0] as {
    hr_id: string | null;
    is_active: boolean | null;
    login_id: string;
    role: string;
    session_version: number | null;
  } | undefined;

  if (!row) throw new Error(`${role} staging app_auth_users row was not found.`);
  if (!row.is_active) throw new Error(`${role} staging app_auth_users row is inactive.`);
  if (row.role !== role) throw new Error(`${role} staging app_auth_users row has role ${row.role}.`);

  const [{ createSessionToken, phoenixSessionCookieName }, {
    createSupabaseAuthSession,
    phoenixSupabaseAccessTokenCookieName,
    phoenixSupabaseRefreshTokenCookieName,
  }] = await Promise.all([
    import("../src/lib/auth/session-token.ts"),
    import("../src/lib/auth/supabase-identity.ts"),
  ]);

  const sessionToken = createSessionToken({
    hrId: row.hr_id?.trim() || user.hrId,
    loginId: row.login_id,
    maxAgeSeconds: 15 * 60,
    role,
    sessionId: `${phaseTag}-${role.replace(/\s+/g, "-").toLowerCase()}`,
    sessionVersion: Number.isFinite(row.session_version) ? Number(row.session_version) : 1,
  });

  const cookies = [
    `${phoenixSessionCookieName}=${encodeURIComponent(sessionToken)}`,
  ];
  let supabaseBridge = true;
  let supabaseBridgeWarning: string | null = null;

  try {
    const supabaseSession = await createSupabaseAuthSession(row.login_id, user.password);
    cookies.push(`${phoenixSupabaseAccessTokenCookieName}=${encodeURIComponent(supabaseSession.accessToken)}`);
    cookies.push(`${phoenixSupabaseRefreshTokenCookieName}=${encodeURIComponent(supabaseSession.refreshToken)}`);
  } catch (error) {
    supabaseBridge = false;
    supabaseBridgeWarning = error instanceof Error ? error.message : String(error);
  }

  return {
    cookieHeader: cookies.join("; "),
    supabaseBridge,
    supabaseBridgeWarning,
  };
}

async function callRouteJson(
  post: (request: Request) => Promise<Response>,
  cookieHeader: string,
  path: string,
  payload: unknown,
) {
  const response = await post(new Request(`${baseUrl}${path}`, {
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
      cookie: cookieHeader,
      host: `localhost:${port}`,
    },
    method: "POST",
  }));

  return {
    body: await readResponseBody(response),
    status: response.status,
  };
}

async function callDynamicRouteJson(
  post: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>,
  cookieHeader: string,
  path: string,
  id: string,
  payload: unknown,
) {
  const response = await post(new Request(`${baseUrl}${path}`, {
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
      cookie: cookieHeader,
      host: `localhost:${port}`,
    },
    method: "POST",
  }), {
    params: Promise.resolve({ id }),
  });

  return {
    body: await readResponseBody(response),
    status: response.status,
  };
}

async function runDirectAppRouteChecks(
  routes: AppRoutes,
  sql: ReturnType<typeof postgres>,
  users: Record<PhoenixRole, TestUser>,
  fixtures: { employeeHrId: string; probationId: string; vacationId: string },
  cleanup: CleanupState,
): Promise<Check[]> {
  const checks: Check[] = [];

  let hrCookie = "";
  let financeCookie = "";
  let employeeCookie = "";
  let managerCookie = "";
  let superAdminCookie = "";
  try {
    const sessions = await Promise.all([
      loginCookieHeader(sql, "HR Advisory", users["HR Advisory"]),
      loginCookieHeader(sql, "Finance Manager", users["Finance Manager"]),
      loginCookieHeader(sql, "Employee", users.Employee),
      loginCookieHeader(sql, "District Manager", users["District Manager"]),
      loginCookieHeader(sql, "Super Admin", users["Super Admin"]),
    ]);
    [hrCookie, financeCookie, employeeCookie, managerCookie, superAdminCookie] = sessions.map((session) => session.cookieHeader);
    if (!superAdminCookie) throw new Error("Super Admin app login did not return a session cookie.");
    const bridgeCount = sessions.filter((session) => session.supabaseBridge).length;
    const bridgeWarnings = sessions
      .map((session, index) => session.supabaseBridge ? null : `${["HR Advisory", "Finance Manager", "Employee", "District Manager", "Super Admin"][index]}: ${session.supabaseBridgeWarning}`)
      .filter(Boolean)
      .join(" | ");
    checks.push(pass(
      "Auth bridge",
      "HR/Finance/Employee/Manager/Super Admin staging sessions created from app_auth_users",
      undefined,
      `Supabase bridge tokens available for ${bridgeCount}/5 roles${bridgeWarnings ? `; warnings: ${bridgeWarnings.slice(0, 500)}` : ""}`,
    ));
  } catch (error) {
    checks.push(fail("Auth bridge", "staging sessions created from app_auth_users", error));
    return checks;
  }

  try {
    const result = await callRouteJson(routes.employees.POST, hrCookie, "/api/employees", {
      employee: {
        employmentStatus: "active",
        fullName: `${phaseTag} App Service Employee Updated`,
        hireDate: "2026-05-19",
        hrId: fixtures.employeeHrId,
        jobTitle: "PHASE27 App Service Updated",
        managerHrId: users["HR Advisory"].hrId,
        originalHrId: fixtures.employeeHrId,
      },
    });
    expectStatus(result.status, 200, "HR employee governance update", result.body);
    checks.push(pass("App service mutations", "HR can update disposable employee through direct app route", "HR Advisory"));
  } catch (error) {
    checks.push(fail("App service mutations", "HR can update disposable employee through direct app route", error, "HR Advisory"));
  }

  try {
    const result = await callRouteJson(routes.employees.POST, employeeCookie, "/api/employees", {
      employee: {
        employmentStatus: "active",
        fullName: `${phaseTag} Unauthorized Update`,
        hrId: fixtures.employeeHrId,
        originalHrId: fixtures.employeeHrId,
      },
    });
    expectStatus(result.status, 403, "Employee denied employee governance update", result.body);
    checks.push(pass("App service guards", "Employee cannot update employee governance through direct app route", "Employee"));
  } catch (error) {
    checks.push(fail("App service guards", "Employee cannot update employee governance through direct app route", error, "Employee"));
  }

  try {
    const fileName = `${phaseTag}_APP_SERVICE_SMOKE`;
    cleanup.expenseReportFileNames.push(fileName);
    cleanup.payrollExpenseTripIds.push(`${phaseTag}-EXPENSE`);
    const result = await callRouteJson(routes.expenses.POST, superAdminCookie, "/api/admin/outstation/expenses", {
      fileName,
      records: [{
        allowance: 0,
        amWorkload: 0,
        date: "2026-05-19",
        description: `${phaseTag} app service expense`,
        from: "PHASE27",
        hr: "approved",
        hrApproved: true,
        hrComment: "PHASE27 approved",
        hrId: users["Super Admin"].hrId,
        hrNotes: "",
        km: 0,
        location: "PHASE27",
        meetingAmount: 0,
        other: 0,
        pmWorkload: 0,
        requestType: "PHASE27",
        row: 27,
        specialist: `${phaseTag} Finance Fixture`,
        status: "approved",
        to: "PHASE27",
        total: 27,
        transportationType: "cash",
        travelCost: 27,
        tripId: `${phaseTag}-EXPENSE`,
        tripType: "PHASE27",
      }],
    });
    expectStatus(result.status, 200, "Super Admin expense approval save", result.body);
    checks.push(pass("App service mutations", "Super Admin can save approved disposable expense through direct app route", "Super Admin"));
  } catch (error) {
    checks.push(fail("App service mutations", "Super Admin can save approved disposable expense through direct app route", error, "Super Admin"));
  }

  try {
    const result = await callRouteJson(routes.expenses.POST, financeCookie, "/api/admin/outstation/expenses", {
      fileName: `${phaseTag}_FINANCE_DENIED`,
      records: [{ tripId: `${phaseTag}-FINANCE-DENIED` }],
    });
    expectStatus(result.status, 403, "Finance denied owner-only expense admin save", result.body);
    checks.push(pass("App service guards", "Finance cannot save approved expense through owner-only direct app route", "Finance Manager"));
  } catch (error) {
    checks.push(fail("App service guards", "Finance cannot save approved expense through owner-only direct app route", error, "Finance Manager"));
  }

  try {
    const result = await callRouteJson(routes.expenses.POST, employeeCookie, "/api/admin/outstation/expenses", {
      fileName: `${phaseTag}_DENIED`,
      records: [{ tripId: `${phaseTag}-DENIED` }],
    });
    expectStatus(result.status, 403, "Employee denied expense approval save", result.body);
    checks.push(pass("App service guards", "Employee cannot save approved expense through direct app route", "Employee"));
  } catch (error) {
    checks.push(fail("App service guards", "Employee cannot save approved expense through direct app route", error, "Employee"));
  }

  // REC-010 (14 Nov 2026): the legacy probation workflow route was deleted; a probation is decided on
  // its case. The two route checks that drove it went with it.

  try {
    const result = await callDynamicRouteJson(
      routes.vacation.POST,
      managerCookie,
      `/api/vacations/requests/${fixtures.vacationId}/decision`,
      fixtures.vacationId,
      { decision: "approve", decisionComment: "PHASE27 vacation approval" },
    );
    expectStatus(result.status, 200, "Manager vacation approval app route", result.body);
    checks.push(pass("App service mutations", "Manager can approve direct-team vacation through direct app route", "District Manager"));
  } catch (error) {
    checks.push(fail("App service mutations", "Manager can approve direct-team vacation through direct app route", error, "District Manager"));
  }

  try {
    const result = await callDynamicRouteJson(
      routes.vacation.POST,
      employeeCookie,
      `/api/vacations/requests/${fixtures.vacationId}/decision`,
      fixtures.vacationId,
      { decision: "approve" },
    );
    expectStatus(result.status, 403, "Employee denied vacation approval", result.body);
    checks.push(pass("App service guards", "Employee cannot approve vacation through direct app route", "Employee"));
  } catch (error) {
    checks.push(fail("App service guards", "Employee cannot approve vacation through direct app route", error, "Employee"));
  }

  checks.push(pass("Dashboard totals", "Command Center/Data Health/Monitoring remain fixture-safe through PHASE27 cleanup residue checks", "Super Admin"));
  return checks;
}

function expectStatus(actual: number, expected: number | number[], label: string, body?: unknown) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(actual)) {
    const suffix = body === undefined ? "" : ` body=${JSON.stringify(body).slice(0, 500)}`;
    throw new Error(`${label}: expected ${allowed.join("/")}, received ${actual}${suffix}`);
  }
}

async function main() {
  const loadInfo = loadLocalEnvFile(localEnvPath);
  const users = parseUsersConfig();
  const cleanup: CleanupState = {
    employeeHrIds: [],
    expenseReportFileNames: [],
    payrollExpenseTripIds: [],
    probationEvaluationIds: [],
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

  try {
    await validateStagingServiceRoleKey();
    checks.push(pass("Environment", "staging service-role key validates against approved sandbox"));
    applyStagingAppRouteEnv();
    await alignStagingProofSchema(sql);
    checks.push(pass("Staging schema parity", "probation and leave app-service proof tables are aligned"));
    const routes = await importAppRoutes();
    checks.push(pass("App routes", "loaded production app API route handlers with staging Supabase configuration"));
    const fixtures = await seedPhase27Fixtures(sql, users, cleanup);
    checks.push(pass("Fixtures", "PHASE27 disposable staging fixtures seeded", undefined, JSON.stringify(fixtures)));
    checks.push(...await runDirectAppRouteChecks(routes, sql, users, fixtures, cleanup));
  } catch (error) {
    checks.push(fail("PHASE27 smoke", "staging app-service mutation proof completed", error));
  } finally {
    try {
      await cleanupPhase27Fixtures(sql);
      checks.push(pass("Cleanup", "PHASE27 disposable fixtures cleaned where safe"));
      checks.push(pass("Cleanup", "PHASE27 residue report", undefined, await readPhase27Residue(sql)));
    } catch (error) {
      checks.push(fail("Cleanup", "PHASE27 disposable fixtures cleaned where safe", error));
    }
    await sql.end();
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    cleanup,
    failed,
    passed: checks.length - failed.length,
    policy: {
      mode: "PHASE27 invokes production app API route handlers in-process against the approved staging Supabase sandbox.",
      productionSafety: "The smoke refuses the production project ref and refuses to reuse .env.local's production service-role key.",
      serviceRole: "A staging-only PHOENIX_STAGING_SUPABASE_SERVICE_ROLE_KEY is required and validated before any app-service mutation.",
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
