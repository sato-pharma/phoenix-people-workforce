// Recruitment / ATS — where the portal's "My Candidates" link sends the Super Admin, worked out
// BEFORE anything renders, so the browser is answered with a real HTTP 307.
//
// The owner, 2026-09-19, twice. He pressed the link in a comment notice and watched it open the
// employee portal and then move on — first to the command center, and after the first fix to the
// recruitment hub. The first fix put the decision in the page
// (`app/employee-portals/recruitment-candidates/page.tsx`), which does choose the right place. But
// `app/employee-portals/loading.tsx` wraps every portal page in a Suspense boundary, so Next flushes
// the portal's loading shell before the page's `redirect()` has run. The response headers are
// committed by then, and the redirect is downgraded to a script that only runs once the client
// bundle has booted: the production HTTP log shows a 200 for the portal address, then the admin
// address 2–3 seconds later. He saw the portal in between, which is exactly what he asked not to.
//
// Only `proxy.ts` runs ahead of that shell, so the decision is made there, the way
// `resolveRootRedirectPath` already does it for "/". The page keeps its own redirect as the fallback
// for everybody this does not cover.
//
// WHY ONLY THE SUPER ADMIN. The proxy can verify the signed session cookie but cannot ask the
// database, and the page's answer for anyone but the Super Admin depends on the permission matrix
// (`canAccess(access, "recruitment", "read")`). For the Super Admin it does not: that check is true
// for the system scope, and the personal inbox is open to him as well. So for this one role the
// cookie alone gives the same answer the page would, and everybody else is left to the page.
//
// SECURITY: this only chooses a URL — it grants nothing. The signature IS verified (a role cannot be
// forged), but the session is deliberately NOT checked against the database: the destination
// re-validates it, so a revoked-but-unexpired token is sent on and bounced to /login from there.
//
// Kept to the two light imports the proxy can afford: `permissions.ts` reaches the database client,
// so the role is written out here and `tests/portal-candidates-proxy-redirect.test.ts` pins it to
// `systemAdministratorRoles`.

import { verifySessionToken } from "@/lib/auth/session-token";
import { adminCandidateHref } from "@/lib/recruitment/candidate-page-link";

/** The roles the proxy may forward without asking the database. Must stay inside `systemAdministratorRoles`. */
export const PORTAL_CANDIDATES_PROXY_ROLES = ["Super Admin"] as const;

/**
 * The admin address a request for the portal's "My Candidates" list should be answered with, or
 * null when the request should carry on to the page.
 *
 * `candidate` is the link's own `?candidate=` value(s), exactly as the address held them: the
 * candidate's page when it is a uuid, the recruitment hub when it is missing or cannot be one (an
 * edited or truncated link, and every notice sent before the id was added). The same
 * `adminCandidateHref` the page uses, so the two places cannot disagree about the destination.
 */
export function resolvePortalCandidatesRedirectPath(
  sessionCookieValue: string | null | undefined,
  candidate: string | string[] | null | undefined,
): string | null {
  const payload = verifySessionToken(sessionCookieValue);
  if (!payload?.role) return null;
  if (!(PORTAL_CANDIDATES_PROXY_ROLES as readonly string[]).includes(payload.role)) return null;

  return adminCandidateHref(candidate);
}
