import bcrypt from "bcryptjs";

import { normalizeRole, type PhoenixRole } from "@/lib/auth/permissions";
import { isEmploymentAccessRevoked } from "@/lib/auth/session-lifecycle";
import { stagingTestSignInKeyMatches } from "@/lib/auth/staging-test-sign-in";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AppAuthUser = {
  authEmail?: string | null;
  authUserId?: string | null;
  email?: string | null;
  forcePasswordReset: boolean;
  hrId: string | null;
  /** A test account (src/lib/auth/test-persona.ts): signs in as itself, reads as the employee it mirrors. */
  isTestPersona: boolean;
  line?: string | null;
  loginId: string;
  managerHrId?: string | null;
  name?: string | null;
  role: PhoenixRole;
  sessionVersion: number;
  /**
   * Set while the stored password is a TEMPORARY one an admin emailed (owner, 12 Nov 2026). Signing in
   * with it opens the choose-your-password screen instead of a session — src/lib/auth/temporary-password.ts.
   */
  temporaryPasswordExpiresAt: string | null;
};

type AppAuthUserDbRow = {
  auth_email?: string | null;
  auth_user_id?: string | null;
  email?: string | null;
  force_password_reset?: boolean | null;
  hr_id: string | null;
  is_active: boolean;
  is_test_persona?: boolean | null;
  line?: string | null;
  login_id: string;
  manager_hr_id?: string | null;
  name?: string | null;
  password_hash: string;
  role: string;
  session_version?: number | null;
  temporary_password_expires_at?: string | null;
  test_persona_of_hr_id?: string | null;
};

/**
 * The employee whose departure ends this login: its own, or — for a test account — the employee it
 * mirrors, so a test account stops working the day that person's departure takes effect.
 */
function lifecycleHrIdOf(row: Pick<AppAuthUserDbRow, "hr_id" | "is_test_persona" | "test_persona_of_hr_id">): string | null {
  return row.is_test_persona === true ? row.test_persona_of_hr_id ?? null : row.hr_id;
}

export function normalizeLoginId(value: string | null | undefined) {
  return String(value ?? "").trim();
}

/**
 * A typed identifier is treated as an email only when it has the `local@domain.tld` shape. HR_IDs
 * (`B-10`) and login IDs never contain an `@`, so this never misroutes them; and refusing anything
 * without a dot after the `@` keeps a half-typed `name@` out of the email branch.
 */
export function looksLikeEmail(value: string | null | undefined): boolean {
  const v = normalizeLoginId(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

const authUserBaseQuery =
  "login_id, password_hash, role, hr_id, is_active, auth_user_id, auth_email, email, line, manager_hr_id, name, session_version, force_password_reset, temporary_password_expires_at, is_test_persona, test_persona_of_hr_id";

// Resolve the Sato email an employee typed to their active auth row. The work mailbox lives on
// employees.work_email (unique), NOT on app_auth_users, so this first tries the optional
// app_auth_users.email override, then the real employees.work_email -> hr_id -> auth row. Every
// path returns the SAME app_auth_users row the HR_ID/login paths return, so authenticateLoginId's
// password check and the terminal-employment gate apply identically — email is a new DOOR to the
// same account, never a new, weaker way in.
async function findActiveAuthUserRowByEmail(email: string): Promise<AppAuthUserDbRow | null> {
  const supabase = getSupabaseAdmin();

  const overrideLookup = await supabase
    .from("app_auth_users")
    .select(authUserBaseQuery)
    .ilike("email", email)
    .eq("is_active", true)
    .maybeSingle();

  if (overrideLookup.error) {
    throw overrideLookup.error;
  }

  if (overrideLookup.data) {
    return overrideLookup.data as AppAuthUserDbRow;
  }

  const employeeLookup = await supabase
    .from("employees")
    .select("hr_id")
    .ilike("work_email", email)
    .maybeSingle();

  if (employeeLookup.error) {
    throw employeeLookup.error;
  }

  const linkedHrId = String((employeeLookup.data as { hr_id?: string | null } | null)?.hr_id ?? "").trim();
  if (!linkedHrId) return null;

  const linkedLookup = await supabase
    .from("app_auth_users")
    .select(authUserBaseQuery)
    .eq("hr_id", linkedHrId.toUpperCase())
    .eq("is_active", true)
    .maybeSingle();

  if (linkedLookup.error) {
    throw linkedLookup.error;
  }

  return (linkedLookup.data as AppAuthUserDbRow | null) ?? null;
}

async function findActiveAuthUserRow(identifierInput: string): Promise<AppAuthUserDbRow | null> {
  const identifier = normalizeLoginId(identifierInput);
  if (!identifier) return null;

  const loginLookup = await getSupabaseAdmin()
    .from("app_auth_users")
    .select(authUserBaseQuery)
    .ilike("login_id", identifier)
    .eq("is_active", true)
    .maybeSingle();

  if (loginLookup.error) {
    throw loginLookup.error;
  }

  if (loginLookup.data) {
    return loginLookup.data as AppAuthUserDbRow;
  }

  const hrLookup = await getSupabaseAdmin()
    .from("app_auth_users")
    .select(authUserBaseQuery)
    .eq("hr_id", identifier.toUpperCase())
    .eq("is_active", true)
    .maybeSingle();

  if (hrLookup.error) {
    throw hrLookup.error;
  }

  if (hrLookup.data) {
    return hrLookup.data as AppAuthUserDbRow;
  }

  // Sign in with the Sato work email as well as the HR_ID / login ID (owner, 2026-10-06).
  if (looksLikeEmail(identifier)) {
    return findActiveAuthUserRowByEmail(identifier);
  }

  return null;
}

export async function resolveStoredLoginId(identifierInput: string): Promise<string | null> {
  const row = await findActiveAuthUserRow(identifierInput);
  return row?.login_id ?? null;
}

// Login-time lifecycle gate: deny sign-in when the linked employee's departure has TAKEN EFFECT
// (resigned / terminated / not_renewed with the last working day passed, or any other non-active
// status) even if app_auth_users.is_active is stale — e.g. a status set via CSV import that
// bypassed the resignation RPC (which normally also flips is_active). Mirrors the read-time session
// gate in src/lib/auth/server.ts so login and session enforce the SAME rule via
// isEmploymentAccessRevoked. Only a CONFIRMED, effective departure blocks; a lookup error or an
// unlinked/missing employee row does NOT block here (login stays available during a transient blip
// — the read-time session gate fails closed and is the backstop).
//
// The date is what makes this correct: an exit filed in ADVANCE flips employment_status days before
// the person actually leaves, and without last_working_date that locked out someone still working.
// See isEmploymentAccessRevoked for the two production incidents behind it.
async function isLinkedEmployeeAccessRevoked(hrId: string | null | undefined): Promise<boolean> {
  const linkedHrId = String(hrId ?? "").trim();
  if (!linkedHrId) return false;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("employment_status, last_working_date")
      .eq("hr_id", linkedHrId)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as { employment_status?: string | null; last_working_date?: string | null };
    return isEmploymentAccessRevoked({
      employmentStatus: row.employment_status,
      lastWorkingDate: row.last_working_date,
      todayCairo: currentCairoDateOnlyIso(),
    });
  } catch {
    return false;
  }
}

function mapAuthUserRow(row: AppAuthUserDbRow): AppAuthUser {
  return {
    authEmail: row.auth_email ?? null,
    authUserId: row.auth_user_id ?? null,
    email: row.email ?? null,
    forcePasswordReset: Boolean(row.force_password_reset),
    hrId: row.hr_id?.trim() || row.login_id.trim(),
    isTestPersona: row.is_test_persona === true,
    line: row.line ?? null,
    loginId: row.login_id,
    managerHrId: row.manager_hr_id ?? null,
    name: row.name ?? row.login_id,
    role: normalizeRole(row.role),
    sessionVersion: Number.isFinite(row.session_version) ? Number(row.session_version) : 1,
    temporaryPasswordExpiresAt: row.temporary_password_expires_at ?? null,
  };
}

export async function authenticateLoginId(loginIdInput: string, password: string): Promise<AppAuthUser | null> {
  const loginId = normalizeLoginId(loginIdInput);
  if (!loginId || !password) return null;

  const row = await findActiveAuthUserRow(loginId);
  if (!row) return null;

  // On STAGING only, a TEST account may sign in with the owner's staging key instead of its own
  // password (src/lib/auth/staging-test-sign-in.ts — three halves, all required; a real login never).
  // The password is tried first, so a test account with a password of its own keeps it.
  const passwordMatches = await bcrypt.compare(password, row.password_hash);
  const stagingKeyMatches =
    !passwordMatches && stagingTestSignInKeyMatches({ isTestPersona: row.is_test_persona === true }, password);
  if (!passwordMatches && !stagingKeyMatches) return null;

  // An employee whose departure has taken effect can never sign in, even if their login was left
  // active. Someone serving out notice still can — the block is dated, not filed. For a test account
  // this reads the MIRRORED person, so the staging key never outlives her either.
  if (await isLinkedEmployeeAccessRevoked(lifecycleHrIdOf(row))) return null;

  // A staging test account whose password was never set would be stopped at "set your password"; the
  // key stands in for that password, so the set-up step is not asked of a key sign-in.
  return stagingKeyMatches ? { ...mapAuthUserRow(row), forcePasswordReset: false } : mapAuthUserRow(row);
}

// Biometric (passkey) sign-in resolves the account AFTER the WebAuthn signature has already been
// verified, so there is no password to compare — possession of the enrolled device is the proof.
//
// 🔴 Every other gate authenticateLoginId applies MUST still apply here, or a passkey becomes a way
// around them. findActiveAuthUserRow enforces is_active, and the terminal-employment check below is
// the one that matters most: a resigned rep whose phone still holds a passkey must be refused at the
// same instant their password stops working. Do not "simplify" this by returning the row directly.
export async function resolveAuthUserForPasswordlessLogin(
  loginIdInput: string,
): Promise<AppAuthUser | null> {
  const loginId = normalizeLoginId(loginIdInput);
  if (!loginId) return null;

  const row = await findActiveAuthUserRow(loginId);
  if (!row) return null;

  if (await isLinkedEmployeeAccessRevoked(lifecycleHrIdOf(row))) return null;

  return mapAuthUserRow(row);
}
