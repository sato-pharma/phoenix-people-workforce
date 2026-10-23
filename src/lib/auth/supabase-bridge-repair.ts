import { errorMessageOf } from "@/lib/http/api-errors";

/**
 * Phoenix has already verified this person's password by the time the Supabase bridge runs — the
 * login route returns `invalid_credentials` long before it. So a sign-in that GoTrue refuses means
 * the Supabase side of the bridge has drifted out of step with Phoenix, and re-provisioning the
 * identity with the password Phoenix just accepted is the repair.
 */
const repairableBridgeFailure = /checking email|email|user not found|invalid login credentials/i;

/**
 * Should the login hot path try to repair the Supabase auth bridge for this user?
 *
 * 🔴 **CLASSIFY ON THE RAW MESSAGE — never on `clientSafeErrorMessage`'s.** That helper REDACTS an
 * infrastructure error, and every Supabase failure here is one: `AuthApiError` matches
 * `isInfrastructureError`'s `/^(Postgrest|Auth|Storage|Functions)[A-Za-z]*Error$/`, so the string
 * it hands back is the caller's own fallback sentence — "Failed to create Supabase auth session." —
 * and never GoTrue's "Invalid login credentials". The pattern above can never match that sentence.
 *
 * The login route classified on the redacted string until 23 Oct 2026, which made this function's
 * answer `false` for **every user who already had `auth_user_id` and `auth_email`** — the exact
 * population the message test exists to serve. The repair was skipped, the login fell through to
 * the warning path, and a login that then SUCCEEDED left a `Failed to create Supabase auth session`
 * row in `app_error_events`: 14 rows on 23 Oct, 11 real people, every one of them signed in. The
 * `{ report: false }` fix of the same morning silenced one of the two doors; this is the other.
 *
 * The raw message is matched here and never returned anywhere — the caller still renders the
 * redacted sentence when the repair genuinely fails.
 */
export function shouldRepairSupabaseAuthBridge(input: {
  authEmail: string | null | undefined;
  authUserId: string | null | undefined;
  error: unknown;
}): boolean {
  if (!input.authUserId) return true;
  if (!input.authEmail) return true;
  return repairableBridgeFailure.test(errorMessageOf(input.error));
}
