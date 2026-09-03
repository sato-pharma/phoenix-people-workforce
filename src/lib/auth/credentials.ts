import bcrypt from "bcryptjs";

import { normalizeRole, type PhoenixRole } from "@/lib/auth/permissions";
import { isEmploymentAccessRevoked } from "@/lib/auth/session-lifecycle";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AppAuthUser = {
  authEmail?: string | null;
  authUserId?: string | null;
  email?: string | null;
  forcePasswordReset: boolean;
  hrId: string | null;
  line?: string | null;
  loginId: string;
  managerHrId?: string | null;
  name?: string | null;
  role: PhoenixRole;
  sessionVersion: number;
};

type AppAuthUserDbRow = {
  auth_email?: string | null;
  auth_user_id?: string | null;
  email?: string | null;
  force_password_reset?: boolean | null;
  hr_id: string | null;
  is_active: boolean;
  line?: string | null;
  login_id: string;
  manager_hr_id?: string | null;
  name?: string | null;
  password_hash: string;
  role: string;
  session_version?: number | null;
};

export function normalizeLoginId(value: string | null | undefined) {
  return String(value ?? "").trim();
}

async function findActiveAuthUserRow(identifierInput: string): Promise<AppAuthUserDbRow | null> {
  const identifier = normalizeLoginId(identifierInput);
  if (!identifier) return null;

  const supabase = getSupabaseAdmin();
  const baseQuery = "login_id, password_hash, role, hr_id, is_active, auth_user_id, auth_email, email, line, manager_hr_id, name, session_version, force_password_reset";

  const loginLookup = await supabase
    .from("app_auth_users")
    .select(baseQuery)
    .ilike("login_id", identifier)
    .eq("is_active", true)
    .maybeSingle();

  if (loginLookup.error) {
    throw loginLookup.error;
  }

  if (loginLookup.data) {
    return loginLookup.data as AppAuthUserDbRow;
  }

  const hrLookup = await supabase
    .from("app_auth_users")
    .select(baseQuery)
    .eq("hr_id", identifier.toUpperCase())
    .eq("is_active", true)
    .maybeSingle();

  if (hrLookup.error) {
    throw hrLookup.error;
  }

  return (hrLookup.data as AppAuthUserDbRow | null) ?? null;
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
    line: row.line ?? null,
    loginId: row.login_id,
    managerHrId: row.manager_hr_id ?? null,
    name: row.name ?? row.login_id,
    role: normalizeRole(row.role),
    sessionVersion: Number.isFinite(row.session_version) ? Number(row.session_version) : 1,
  };
}

export async function authenticateLoginId(loginIdInput: string, password: string): Promise<AppAuthUser | null> {
  const loginId = normalizeLoginId(loginIdInput);
  if (!loginId || !password) return null;

  const row = await findActiveAuthUserRow(loginId);
  if (!row) return null;

  const passwordMatches = await bcrypt.compare(password, row.password_hash);
  if (!passwordMatches) return null;

  // An employee whose departure has taken effect can never sign in, even if their login was left
  // active. Someone serving out notice still can — the block is dated, not filed.
  if (await isLinkedEmployeeAccessRevoked(row.hr_id)) return null;

  return mapAuthUserRow(row);
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

  if (await isLinkedEmployeeAccessRevoked(row.hr_id)) return null;

  return mapAuthUserRow(row);
}
