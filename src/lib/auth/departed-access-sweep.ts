/**
 * The daily catch-up that switches off a leaver's login once their last working day has arrived.
 *
 * WHY THIS EXISTS. A departure used to revoke access the moment HR FILED the exit. HR files exits
 * in advance, so people were locked out while still working — on 2026-08-30 that cost A-16 nine
 * failed logins, a manual account re-activation by HR, two password resets and a password setup
 * inside four minutes, none of which could work. The revocation is now DATED (the resignation RPC
 * and src/lib/resignations/service.ts both defer it), and something has to perform it when the day
 * comes. This is that something.
 *
 * A STALE FLAG IS NOT AN OPEN DOOR. From the last working day onward the auth gate refuses both
 * login and session on `employees.employment_status` regardless of `app_auth_users.is_active`
 * (session-lifecycle.ts, isEmploymentAccessRevoked — the same rule the deferral uses, so the two
 * cannot drift). So a run that fails or is skipped leaves the flag lagging the block, never leading
 * it. That is why this is allowed to be best-effort and why it does not drive an alarm of its own.
 *
 * THE MATCHING IS ONE SQL STATEMENT, deliberately. Two traps in this repository make the
 * client-side version wrong: HR ids are MIXED CASE, so a PostgREST `.eq()`/`.in()` silently
 * under-matches, and an `.in()` carrying several hundred ids returns zero rows with no error at
 * all. The function lowers and trims both sides and has no such cliff. It is idempotent, so a
 * missed day self-heals.
 *
 * IT THEN FINISHES WHAT SQL CANNOT. Disabling the leaver's Telegram is an external call, and the
 * resignation flow no longer does it at filing time — that is dated now, like the login flip. So
 * this has to, or an ex-employee keeps receiving company notifications indefinitely, which is a
 * worse bug than the early lockout the change removes. That is why the SQL function returns the
 * ids it revoked rather than only counting them.
 */

import { disableTelegramForIdentity } from "@/lib/notifications/settings";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type DepartedAccessSweepResult = {
  loginsRevoked: number;
  accessProfilesRevoked: number;
  telegramDisabled: number;
  errors: number;
};

function countFrom(payload: unknown, key: string): number {
  if (!payload || typeof payload !== "object") return 0;
  const value = (payload as Record<string, unknown>)[key];
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function revokedHrIdsFrom(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const value = (payload as Record<string, unknown>).revoked_hr_ids;
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0);
}

/**
 * Revokes every departed employee's login whose last working day has passed.
 *
 * Never throws: the caller is a cron endpoint that also runs the mailbox sweep, and a failure here
 * must not take that down or turn its dead-man's switch red — the two answer different questions.
 * A failure is logged and counted, and the next run retries.
 */
export async function runDepartedAccessSweep(): Promise<DepartedAccessSweepResult> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("phx_revoke_departed_employee_access");
    if (error) throw error;

    // Finish what SQL cannot. The resignation flow no longer disables Telegram at filing time —
    // that is dated now like the login flip — so if this did not do it, an ex-employee would keep
    // receiving company notifications indefinitely. Only the ids just revoked are touched, so a
    // quiet day costs nothing and a repeat run cannot re-disable anybody.
    const revoked = revokedHrIdsFrom(data);
    let telegramDisabled = 0;
    let errors = 0;
    for (const hrId of revoked) {
      try {
        await disableTelegramForIdentity({
          actorLoginId: "system",
          hrId,
          reason: "Employee resigned, terminated, or deactivated.",
        });
        telegramDisabled += 1;
      } catch (error) {
        errors += 1;
        logError("Departed access sweep could not disable Telegram for a leaver", {
          labels: { event: "departed_access_telegram_failed", cron: "mailbox-offboarding-sweep" },
          context: { hrId },
          error,
        });
      }
    }

    return {
      loginsRevoked: countFrom(data, "logins_revoked"),
      accessProfilesRevoked: countFrom(data, "access_profiles_revoked"),
      telegramDisabled,
      errors,
    };
  } catch (error) {
    logError("Departed access sweep could not revoke leaver logins", {
      labels: { event: "departed_access_sweep_failed", cron: "mailbox-offboarding-sweep" },
      error,
    });
    return { loginsRevoked: 0, accessProfilesRevoked: 0, telegramDisabled: 0, errors: 1 };
  }
}
