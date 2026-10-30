/**
 * VIEW AS SEAT — the Super Admin looks at the live site exactly as another seat sees it, READ ONLY.
 *
 * Owner, 2026-10-20: "View as seat … finish it and merge for me to use", and, asked which seats:
 * "Office seats + a person picker". So:
 *
 *   - An OFFICE seat (the admin shell: the HR seats, SFE, Finance, Financial Advisor, the CEO) is
 *     viewed by its ROLE alone — the seat may have nobody in it, which is exactly when he wants to see it.
 *   - A PORTAL seat (reps, managers, every employee-portal role) is viewed AS ONE CHOSEN PERSON holding
 *     it, because a portal seat with nobody in it shows nothing.
 *
 * How it is safe on production:
 *   - It never replaces the owner's session. A separate cookie (seat-view-token.ts) is honoured only on
 *     top of HIS live Super Admin session, and only the one it names — `applySeatView` below.
 *   - Nothing writes. Every non-read request is refused (`seatViewMayRun`), the only exception being the
 *     exit itself; server actions are refused too; and reads that would leave a row behind (an export,
 *     a CV opened, a pack printed, a search logged) are refused as well. `isPreviewSession` treats a view
 *     as a preview, so the payroll and expense decision guards refuse it a second time.
 *   - The view carries the login id SEAT-VIEW — never the owner's (his mailbox, layouts and actor would
 *     bleed in) and never the person's (nothing may act as them).
 *
 * The dev preview (dev-preview.ts) is a different thing for the local laptop and is untouched by this.
 */

import {
  assignablePhoenixRoles,
  createAccessContext,
  parseRoleStrict,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { isPortalShellRole } from "@/lib/auth/portal-shell-roles";
import { verifySessionToken } from "@/lib/auth/session-token";
import { forbiddenError } from "@/lib/http/api-errors";

import { isSeatView } from "./read-only-viewer.ts";
import { SEAT_VIEW_EXIT_PATH, SEAT_VIEW_LOGIN_ID, SEAT_VIEW_REFUSAL } from "./seat-view-constants.ts";
import { verifySeatViewToken } from "./seat-view-token.ts";

/** Every seat the owner may view: every assignable role but his own. A new seat appears by itself. */
export function seatViewableRoles(): PhoenixRole[] {
  return assignablePhoenixRoles.filter((role) => role !== "Super Admin");
}

export function seatViewOfficeRoles(): PhoenixRole[] {
  return seatViewableRoles().filter((role) => !isPortalShellRole(role));
}

export function seatViewPortalRoles(): PhoenixRole[] {
  return seatViewableRoles().filter((role) => isPortalShellRole(role));
}

export function isSeatViewableRole(role: string | null | undefined): role is PhoenixRole {
  return (seatViewableRoles() as readonly string[]).includes(String(role ?? ""));
}

/**
 * Whether a seat is viewed as a person. A portal seat needs one (it shows nothing without); an office
 * seat is viewed by role alone in this first version — its pages were never vetted for what merely
 * LOOKING at them as a named person might write, the way the portal was for test accounts.
 */
export function seatViewPersonRule(role: string | null | undefined): "required" | "forbidden" {
  return isPortalShellRole(role) ? "required" : "forbidden";
}

export { isReadOnlyViewer, isSeatView } from "./read-only-viewer.ts";

/**
 * Layer a seat view onto the owner's session — or return null and leave his session exactly as it is.
 *
 * Every condition must hold, and any failure IGNORES the cookie (it expires within the hour, and Exit
 * and sign-out delete it): a real Super Admin session, not a test account, not already a view; the token
 * signed for THIS session id and THIS login; a seat that may be viewed; and the person rule.
 */
export function applySeatView(
  owner: AccessContext,
  sessionToken: string | null | undefined,
  seatToken: string | null | undefined,
): AccessContext | null {
  if (!seatToken) return null;
  if (owner.source !== "session" || owner.role !== "Super Admin") return null;
  if (owner.testPersona || owner.seatView) return null;

  const view = verifySeatViewToken(seatToken);
  if (!view) return null;

  const session = verifySessionToken(sessionToken);
  if (!session || session.sid !== view.ownerSid) return null;
  if (!owner.loginId || owner.loginId !== view.ownerLoginId) return null;

  let role: PhoenixRole;
  try {
    role = parseRoleStrict(view.role);
  } catch {
    return null;
  }
  if (!isSeatViewableRole(role)) return null;
  const rule = seatViewPersonRule(role);
  if (rule === "required" && !view.hrId) return null;
  if (rule === "forbidden" && view.hrId) return null;

  return createAccessContext({
    hrId: view.hrId,
    loginId: SEAT_VIEW_LOGIN_ID,
    role,
    source: "session",
    seatView: {
      ownerLoginId: view.ownerLoginId,
      personName: view.personName,
      expiresAt: view.exp,
    },
  });
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The same test tests/access-registry-coverage.test.ts uses for a route that hands a file away. */
const EXPORT_LIKE_PATH = /(^|\/|-)(export|download|template)(\/|$)|events-csv$|payslips\/image$/;

/**
 * GET routes that leave a row behind merely by being read — a CV opened, a pack printed, a search
 * logged, a contact list or pack taken away, a snapshot written. Refused during a view so that looking
 * never records the viewed seat as having done any of it. tests/seat-view.test.ts sweeps every GET
 * handler for write calls and fails when one is neither refused here nor named there with a reason.
 */
export const SEAT_VIEW_REFUSED_READS: readonly RegExp[] = [
  /^\/api\/recruitment\/hiring-manager\/candidates\/[^/]+\/files\//,
  // A candidate's CV opened from a Phoenix CRM Interviews day — it writes an audit row naming who opened it.
  /^\/api\/phoenix-crm\/day-interviews\/cv(\/|$)/,
  /^\/api\/hiring-pack\/[^/]+\/print(\/|$)/,
  /^\/api\/recruitment\/cv-lookup(\/|$)/,
  /^\/api\/reports\/organogram\/contact-numbers(\/|$)/,
  /^\/api\/business-review\/pack(\/|$)/,
  /^\/api\/admin\/field-workforce-compliance\/live-snapshots(\/|$)/,
  /^\/api\/admin\/activity\/timeline(\/|$)/,
  // Mints a lasting calendar-feed link for the viewer — refused to a test account for the same reason.
  /^\/api\/recruitment\/interview-calendar\/my-calendar-feed(\/|$)/,
  // The month's bank transfer file: every account number and amount, and an audit row naming who took it.
  /^\/api\/payroll\/[^/]+\/bank-file(\/|$)/,
];

/** Whether a request with this method and path may run during a seat view. */
export function seatViewMayRun(method: string | null | undefined, pathname: string | null | undefined): boolean {
  const verb = String(method ?? "GET").toUpperCase();
  const path = String(pathname ?? "");
  if (verb === "POST" && path === SEAT_VIEW_EXIT_PATH) return true;
  if (!READ_METHODS.has(verb)) return false;
  if (EXPORT_LIKE_PATH.test(path)) return false;
  return !SEAT_VIEW_REFUSED_READS.some((pattern) => pattern.test(path));
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, "http://phoenix.local").pathname;
  } catch {
    return "";
  }
}

/** Throws the refusal when a seat view sends anything but a plain read (or the exit). */
export function assertSeatViewMayRun(access: Pick<AccessContext, "seatView">, request: Pick<Request, "method" | "url">): void {
  if (!isSeatView(access)) return;
  if (seatViewMayRun(request.method, pathnameOf(request.url))) return;
  throw forbiddenError(SEAT_VIEW_REFUSAL);
}

/** For a write that does not arrive as an API request (a server action or a form post). */
export function assertNotSeatView(access: Pick<AccessContext, "seatView">): void {
  if (isSeatView(access)) throw forbiddenError(SEAT_VIEW_REFUSAL);
}
