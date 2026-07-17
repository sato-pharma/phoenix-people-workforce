import { type AccessContext } from "@/lib/auth/permissions";

/**
 * True for the guest fallback (session expired/absent): no login_id AND no hr_id.
 *
 * Pure + testable. Lives in its own module (no value imports) so tests can exercise it
 * without loading next/navigation or the server-only auth stack that the page wrapper
 * in ./page-access.ts pulls in.
 */
export function isGuestFallbackAccess(access: Pick<AccessContext, "loginId" | "hrId">): boolean {
  return !access.loginId && !access.hrId;
}
