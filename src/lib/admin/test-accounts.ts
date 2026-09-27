/**
 * Test accounts — the Super Admin's screen behind them (/admin/test-accounts).
 *
 * What a test account IS, and why it can never write as the person it mirrors, is written once in
 * src/lib/auth/test-persona.ts. This file only makes, repoints and switches them off:
 *
 *   - Creating one inserts an `app_auth_users` row with `is_test_persona = true`, NO hr_id of its own,
 *     a `TEST-…` login id, and the role and line of the mirrored person's own account. Its first
 *     password is random and unknowable; `force_password_reset` is on, so the only way in is the
 *     one-time set-password link the Super Admin copies from the screen and opens himself. No email is
 *     ever sent, and no password ever passes through this code in the clear.
 *   - Pointing it at somebody else copies that person's role and line again and bumps
 *     `session_version`, so every open session of the test account ends and the next sign-in is the
 *     new person's.
 *   - Only an employee-portal role can be mirrored, and only a person whose own login is active and
 *     whose departure has not taken effect — the same people who could sign in as themselves today.
 */

import bcrypt from "bcryptjs";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { createTemporaryAuthPassword, sendPasswordSetupLink } from "@/lib/auth/password-setup";
import { isEmploymentAccessRevoked } from "@/lib/auth/session-lifecycle";
import { canBeMirrored, normalizeTestAccountLoginId, TEST_ACCOUNT_LOGIN_PREFIX } from "@/lib/auth/test-persona";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TestAccountPerson = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  role: string;
  area: string | null;
  region: string | null;
  line: string | null;
};

export type TestAccount = {
  loginId: string;
  name: string;
  isActive: boolean;
  /** False until the Super Admin has opened the set-password link and chosen a password. */
  passwordSet: boolean;
  role: string;
  mirrors: TestAccountPerson | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type TestAccountsView = {
  accounts: TestAccount[];
  /** The people a test account may be pointed at, by name. */
  people: TestAccountPerson[];
};

type AuthRow = {
  login_id: string;
  hr_id: string | null;
  name: string | null;
  role: string;
  line: string | null;
  is_active: boolean;
  force_password_reset: boolean | null;
  is_test_persona: boolean | null;
  test_persona_of_hr_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  session_version: number | null;
  sales_scope_override: string | null;
  line_scope_override: string[] | null;
  product_scope_override: string[] | null;
};

type EmployeeRow = {
  hr_id: string;
  full_name: string | null;
  nickname: string | null;
  job_title: string | null;
  area_name: string | null;
  region_name: string | null;
  employment_status: string | null;
  last_working_date: string | null;
};

const AUTH_COLUMNS =
  "login_id, hr_id, name, role, line, is_active, force_password_reset, is_test_persona, test_persona_of_hr_id, created_at, updated_at, session_version, sales_scope_override, line_scope_override, product_scope_override";

/**
 * What a test account copies from the mirrored person's own account. The sales screens read these per
 * LOGIN (src/lib/auth/scope-visibility.ts, src/lib/sales/access-scope.ts), so without them a test
 * account would see the role's default reach rather than hers.
 */
function copiedFromMirror(account: AuthRow) {
  return {
    line: account.line ?? "Other",
    line_scope_override: account.line_scope_override,
    product_scope_override: account.product_scope_override,
    role: account.role,
    sales_scope_override: account.sales_scope_override,
  };
}
const EMPLOYEE_COLUMNS = "hr_id, full_name, nickname, job_title, area_name, region_name, employment_status, last_working_date";

/** The Super Admin, holding user administration — the same pair the Users screen asks for. */
export async function assertTestAccountAdmin(access: AccessContext): Promise<void> {
  if (access.role !== "Super Admin" || access.testPersona) throw forbiddenError("Only the Super Admin manages test accounts.");
  if (!(await canAccess(access, "user_admin", "update"))) throw forbiddenError("Only the Super Admin manages test accounts.");
}

function hrKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function personOf(employee: EmployeeRow, account: Pick<AuthRow, "role" | "line">): TestAccountPerson {
  return {
    hrId: employee.hr_id,
    name: resolveEmployeeDisplayName(employee.full_name?.trim() || employee.hr_id, employee.nickname, employee.hr_id),
    jobTitle: employee.job_title,
    role: account.role,
    area: employee.area_name,
    region: employee.region_name,
    line: account.line,
  };
}

async function loadEmployees(hrIds: string[]): Promise<Map<string, EmployeeRow>> {
  const unique = [...new Set(hrIds.map((id) => id.trim()).filter(Boolean))];
  const byKey = new Map<string, EmployeeRow>();
  for (let index = 0; index < unique.length; index += 200) {
    const { data, error } = await getSupabaseAdmin().from("employees").select(EMPLOYEE_COLUMNS).in("hr_id", unique.slice(index, index + 200));
    if (error) throw error;
    for (const row of (data ?? []) as EmployeeRow[]) byKey.set(hrKey(row.hr_id), row);
  }
  return byKey;
}

/** A person may be mirrored when their own login is active, portal-shell, and their departure has not taken effect. */
function mirrorable(account: AuthRow, employee: EmployeeRow | undefined, todayCairo: string): employee is EmployeeRow {
  if (!employee || !account.is_active || account.is_test_persona === true || !account.hr_id) return false;
  if (!canBeMirrored(account.role)) return false;
  return !isEmploymentAccessRevoked({
    employmentStatus: employee.employment_status,
    lastWorkingDate: employee.last_working_date,
    todayCairo,
  });
}

export async function loadTestAccounts(): Promise<TestAccountsView> {
  const { data, error } = await getSupabaseAdmin().from("app_auth_users").select(AUTH_COLUMNS);
  if (error) throw error;
  const rows = (data ?? []) as AuthRow[];
  const tests = rows.filter((row) => row.is_test_persona === true);
  const real = rows.filter((row) => row.is_test_persona !== true && row.hr_id);
  const employees = await loadEmployees([
    ...real.map((row) => row.hr_id as string),
    ...tests.map((row) => row.test_persona_of_hr_id ?? ""),
  ]);
  const accountByHr = new Map(real.map((row) => [hrKey(row.hr_id), row]));
  const today = currentCairoDateOnlyIso();

  const people = real
    .map((row) => ({ row, employee: employees.get(hrKey(row.hr_id)) }))
    .filter((entry): entry is { row: AuthRow; employee: EmployeeRow } => mirrorable(entry.row, entry.employee, today))
    .map(({ row, employee }) => personOf(employee, row))
    .sort((left, right) => left.name.localeCompare(right.name));

  const accounts = tests
    .map((row): TestAccount => {
      const employee = row.test_persona_of_hr_id ? employees.get(hrKey(row.test_persona_of_hr_id)) : undefined;
      const mirroredAccount = accountByHr.get(hrKey(row.test_persona_of_hr_id));
      return {
        loginId: row.login_id,
        name: row.name?.trim() || row.login_id,
        isActive: row.is_active,
        passwordSet: row.force_password_reset !== true,
        role: row.role,
        mirrors: employee ? personOf(employee, { role: row.role, line: mirroredAccount?.line ?? row.line }) : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    })
    .sort((left, right) => left.loginId.localeCompare(right.loginId));

  return { accounts, people };
}

/** The mirrored person's own account and employee row, or a sentence saying why they cannot be mirrored. */
async function resolveMirror(hrIdInput: unknown): Promise<{ account: AuthRow; employee: EmployeeRow }> {
  const hrId = String(hrIdInput ?? "").trim();
  if (!hrId) throw validationError("Choose the person this test account works as.");
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select(AUTH_COLUMNS)
    .eq("hr_id", hrId)
    .eq("is_active", true)
    .eq("is_test_persona", false);
  if (error) throw error;
  const accounts = (data ?? []) as AuthRow[];
  const employees = await loadEmployees([hrId]);
  const employee = employees.get(hrKey(hrId));
  const account = accounts.find((row) => mirrorable(row, employee, currentCairoDateOnlyIso()));
  if (!account || !employee) {
    throw validationError(
      "This person cannot be mirrored: a test account works only as someone with an active login in the employee portal who is still with the company.",
    );
  }
  return { account, employee };
}

function testAccountName(employee: EmployeeRow): string {
  return `Test · ${resolveEmployeeDisplayName(employee.full_name?.trim() || employee.hr_id, employee.nickname, employee.hr_id)}`;
}

async function loadTestAccountRow(loginIdInput: unknown): Promise<AuthRow> {
  const loginId = normalizeTestAccountLoginId(loginIdInput);
  if (!loginId) throw notFoundError("That test account was not found.");
  const { data, error } = await getSupabaseAdmin().from("app_auth_users").select(AUTH_COLUMNS).eq("login_id", loginId).maybeSingle();
  if (error) throw error;
  const row = data as AuthRow | null;
  if (!row || row.is_test_persona !== true) throw notFoundError("That test account was not found.");
  return row;
}

export async function createTestAccount(
  input: { loginId: unknown; mirrorsHrId: unknown },
  actor: AccessContext,
): Promise<{ loginId: string }> {
  const loginId = normalizeTestAccountLoginId(input.loginId);
  if (!loginId) {
    throw validationError(`A test account's login starts with ${TEST_ACCOUNT_LOGIN_PREFIX} and then letters or numbers — for example TEST-AYA.`);
  }
  const supabase = getSupabaseAdmin();
  // Sign-in looks a login up case-insensitively, so a clash is checked the same way.
  const clash = await supabase.from("app_auth_users").select("login_id").ilike("login_id", loginId).limit(1);
  if (clash.error) throw clash.error;
  if ((clash.data ?? []).length > 0) throw conflictError(`${loginId} is already a login. Choose another name.`);

  const { account, employee } = await resolveMirror(input.mirrorsHrId);
  const now = new Date().toISOString();
  const row = {
    login_id: loginId,
    hr_id: null,
    name: testAccountName(employee),
    ...copiedFromMirror(account),
    is_active: true,
    // A random first password nobody knows; the set-password link is the only way in.
    password_hash: await bcrypt.hash(createTemporaryAuthPassword(), 12),
    force_password_reset: true,
    session_version: 1,
    is_test_persona: true,
    test_persona_of_hr_id: employee.hr_id,
    created_at: now,
    updated_at: now,
  };
  const { error } = await supabase.from("app_auth_users").insert(row);
  if (error) {
    if ((error as { code?: string }).code === "23505") throw conflictError(`${loginId} is already a login. Choose another name.`);
    throw error;
  }

  await writeRequiredAuditLog({
    actorLoginId: actor.loginId ?? null,
    entityId: loginId,
    entityType: "user",
    newValues: { isTestAccount: true, loginId, mirrorsHrId: employee.hr_id, role: account.role },
    summary: `Test account ${loginId} created, working as ${row.name.replace(/^Test · /, "")}`,
  });
  return { loginId };
}

export async function updateTestAccount(
  input: { loginId: unknown; mirrorsHrId?: unknown; isActive?: unknown },
  actor: AccessContext,
): Promise<{ loginId: string }> {
  const current = await loadTestAccountRow(input.loginId);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  let summary = "";

  if (input.mirrorsHrId !== undefined && hrKey(String(input.mirrorsHrId)) !== hrKey(current.test_persona_of_hr_id)) {
    const { account, employee } = await resolveMirror(input.mirrorsHrId);
    Object.assign(patch, {
      ...copiedFromMirror(account),
      name: testAccountName(employee),
      test_persona_of_hr_id: employee.hr_id,
    });
    summary = `now working as ${testAccountName(employee).replace(/^Test · /, "")}`;
  }
  if (typeof input.isActive === "boolean" && input.isActive !== current.is_active) {
    patch.is_active = input.isActive;
    summary = [summary, input.isActive ? "switched on" : "switched off"].filter(Boolean).join(", ");
  }
  if (!summary) return { loginId: current.login_id };

  // Every change ends the test account's open sessions: the next sign-in is the new person, or none.
  patch.session_version = (Number.isFinite(current.session_version) ? Number(current.session_version) : 1) + 1;
  const { error } = await getSupabaseAdmin().from("app_auth_users").update(patch).eq("login_id", current.login_id).eq("is_test_persona", true);
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: actor.loginId ?? null,
    entityId: current.login_id,
    entityType: "user",
    newValues: { isTestAccount: true, ...patch },
    oldValues: { isActive: current.is_active, mirrorsHrId: current.test_persona_of_hr_id, role: current.role },
    summary: `Test account ${current.login_id} ${summary}`,
  });
  return { loginId: current.login_id };
}

/** The one-time set-password link, for the Super Admin to open himself. Never emailed. */
export async function testAccountPasswordLink(
  input: { loginId: unknown },
  actor: AccessContext,
  origin: string,
): Promise<{ loginId: string; setupUrl: string; expiresAt: string | null }> {
  const current = await loadTestAccountRow(input.loginId);
  if (!current.is_active) throw validationError("Switch the test account on before making its password link.");
  const result = await sendPasswordSetupLink({
    actorLoginId: actor.loginId ?? null,
    deliveryMode: "copy",
    loginId: current.login_id,
    origin,
    purpose: current.force_password_reset === true ? "setup" : "reset",
  });
  if (!result.setupUrl) throw new Error("The password link could not be made.");
  return { loginId: current.login_id, setupUrl: result.setupUrl, expiresAt: result.expiresAt };
}
