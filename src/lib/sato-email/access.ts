import { canAccessSystemAdministratorWorkspace, type AccessContext } from "@/lib/auth/permissions";

/**
 * Who may open the Sato Email Composer: Super Admin and the HR Business Partner (the job title the
 * `HR Advisory` seat is shown under). Owner 2026-09-11: "This module would be accessible for HR
 * business partner and the system administrator."
 *
 * By name rather than through `communication`, for the same reason as the distribution lists: that
 * resource also opens the old composer, the system email templates and the Telegram console, so it
 * cannot express "this module and nothing else".
 */
export function canUseSatoEmail(access: Pick<AccessContext, "role" | "scope">): boolean {
  return canAccessSystemAdministratorWorkspace(access) || access.role === "HR Advisory";
}
