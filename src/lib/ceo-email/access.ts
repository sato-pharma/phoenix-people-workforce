import { canAccessSystemAdministratorWorkspace, type AccessContext } from "@/lib/auth/permissions";

/**
 * Who may open the CEO Email Composer.
 *
 * The CEO himself, and the Super Admin — the seat that builds and repairs the module and is the only
 * one who can see a failure on it. Nobody else: this screen mails a distribution list under the
 * chief executive's own name and signature, which is the one identity in this company that cannot
 * be lent out.
 *
 * By name rather than through a `communication` resource, for the same reason as `canUseSatoEmail`:
 * that resource also opens the older HR composer, the system email templates and the Telegram
 * console, so it cannot express "this module and nothing else".
 *
 * 🔴 IT IS NOT `canUseSatoEmail` AND MUST NEVER BECOME IT. The HR Business Partner may send in the
 * COMPANY's identity (the Sato composer) and may not send in the CEO's; the CEO may send in his own
 * and has no business in the HR composer. Two screens, two gates, one predicate each.
 */
export function canUseCeoEmail(access: Pick<AccessContext, "role" | "scope">): boolean {
  return canAccessSystemAdministratorWorkspace(access) || access.role === "CEO";
}
