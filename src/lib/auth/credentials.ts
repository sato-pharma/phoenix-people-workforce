import bcrypt from "bcryptjs";

import { normalizeRole, type PhoenixRole } from "@/lib/auth/permissions";
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
    .ilike("hr_id", identifier)
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

export async function authenticateLoginId(loginIdInput: string, password: string): Promise<AppAuthUser | null> {
  const loginId = normalizeLoginId(loginIdInput);
  if (!loginId || !password) return null;

  const row = await findActiveAuthUserRow(loginId);
  if (!row) return null;

  const passwordMatches = await bcrypt.compare(password, row.password_hash);
  if (!passwordMatches) return null;

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
