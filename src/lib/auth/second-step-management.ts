/**
 * What the account's own screen needs around the second sign-in step (second-step.ts): proving the
 * person at the keyboard knows the account's password before a change, and the list of the other accounts
 * a Super Admin may reset.
 *
 * WHY A PASSWORD AND NOT A CODE. Every change here is made from a session that already passed the second
 * step (or a passkey). The risk left is a session used by someone else: an unlocked laptop, a copied
 * cookie. That person does not know the password, so the password is what stops them. Asking for an
 * authenticator code instead would lock out exactly the person these screens exist for: the one whose
 * phone is gone, who signed in with a passkey and needs to reset.
 */

import bcrypt from "bcryptjs";

import { normalizeRole } from "@/lib/auth/permissions";
import { secondStepRequiredForRole } from "@/lib/auth/second-step";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** True when `password` is the stored account's current password. A missing account is false. */
export async function accountPasswordMatches(loginId: string, password: string): Promise<boolean> {
  if (typeof password !== "string" || !password) return false;
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id, password_hash, is_active")
    .eq("login_id", loginId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { is_active?: boolean | null; password_hash?: string | null } | null;
  if (!row || row.is_active === false || !row.password_hash) return false;
  return bcrypt.compare(password, row.password_hash);
}

export type OtherSecondStepAccount = {
  loginId: string;
  name: string;
  setUp: boolean;
};

/**
 * The other active accounts the second step is asked of, each with whether it is set up.
 *
 * The role is read the way sign-in reads it (`normalizeRole`), never matched as stored text: an account
 * whose role is stored as "super admin" or "admin" IS asked for the step at sign-in, so it must be on this
 * list too, or nobody could reset it from the card.
 */
export async function listOtherSecondStepAccounts(exceptLoginId: string): Promise<OtherSecondStepAccount[]> {
  const supabase = getSupabaseAdmin();
  const { data: users, error: usersError } = await supabase
    .from("app_auth_users")
    .select("login_id, name, role, is_active, is_test_persona")
    .eq("is_active", true);
  if (usersError) throw usersError;

  const others = ((users ?? []) as Array<{ is_test_persona?: boolean | null; login_id: string; name?: string | null; role?: string | null }>)
    .filter((user) => secondStepRequiredForRole(normalizeRole(user.role)))
    .filter((user) => user.login_id !== exceptLoginId && user.is_test_persona !== true);
  if (others.length === 0) return [];

  const { data: rows, error: rowsError } = await supabase
    .from("app_auth_second_step")
    .select("login_id, secret_sealed")
    .in("login_id", others.map((user) => user.login_id));
  if (rowsError) throw rowsError;
  const setUp = new Set(
    ((rows ?? []) as Array<{ login_id: string; secret_sealed?: string | null }>)
      .filter((row) => Boolean(row.secret_sealed))
      .map((row) => row.login_id),
  );

  return others
    .map((user) => ({ loginId: user.login_id, name: user.name?.trim() || user.login_id, setUp: setUp.has(user.login_id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
