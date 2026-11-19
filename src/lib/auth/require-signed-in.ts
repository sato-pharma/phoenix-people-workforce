import { type AccessContext } from "@/lib/auth/permissions";
import { isGuestFallbackAccess } from "@/lib/auth/page-access-guard";
import { unauthorizedError } from "@/lib/http/api-errors";

/**
 * Refuses a signed-out caller with a 401 ("Authentication is required.") — the guest context a request
 * with no session gets: source "guest", or no login id and no HR id.
 *
 * A write route asks this BEFORE it reads its body or judges its path. Eighty-one route answers judged
 * the input first and told a stranger "400: decision must be approve or reject", so a caller with no
 * session learned which bodies are good (REC-080, the BODY_FIRST gap kind, closed 19 Nov 2026).
 * It never refuses anyone signed in: a role the route refuses is still the route's own check.
 */
export function assertSignedIn(access: Pick<AccessContext, "hrId" | "loginId" | "source">): void {
  if (access.source === "guest" || isGuestFallbackAccess(access)) throw unauthorizedError();
}
