// Where the closing-published email's one shared "Open Phoenix Workforce" link lands each person.
//
// The email has a single CTA URL for every recipient — the line's District Managers and NSM, the
// line's Product Managers, and the three company roles Cc'd on every line (CEO, Marketing Manager,
// SFE Manager; see closing-publish-recipients.ts) — so the URL cannot know in advance which page
// each of them can even open. app/api/sales/monthly-closing/go/route.ts resolves it server-side and
// redirects, and this module is the rule it applies.
//
// 🔴 IT LIVES HERE, APART FROM THE ROUTE, BECAUSE THE RULE DRIFTED FROM THE PAGE ONCE AND NOBODY
// COULD SEE IT. The admin Closing Matrix admitted only Super Admin, system scope and the SFE
// Manager when the email was built, so the route sent the CEO to his Command Center and said so in
// a comment: "granting the CEO a Matrix view is a real access-control decision this route does not
// make on its own". On 2026-09-07 the owner made exactly that decision — the CEO reported the
// module missing, was offered the read-only analytics mount instead and refused it, and the PAGE
// was changed to admit him read-only (canPublish false). The route was not, and nothing tied the
// two together, so for five weeks the only link in the email could not reach the page he had asked
// for by name. The test beside this module (tests/closing-publish-email-destination.test.ts) now
// reads the page's own role guard and fails if the two disagree again.

import { resolveLandingPathForRole } from "@/lib/auth/landing";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { canAccessPortalClosing } from "@/lib/sales/monthly-closing-portal";

/**
 * The roles the admin Closing Matrix page itself admits — kept in step with the role guard in
 * app/(admin)/sales/monthly-closing/page.tsx, which is the security boundary. `Super Admin` is
 * here for completeness; the resolver also admits any viewer whose scope is `system`, exactly as
 * that page does.
 *
 * Read-only for the SFE Manager and the CEO: the page's `canPublish` stays false for both, and
 * publish/unpublish/lock keep their own independent Super-Admin-only guards in their routes. This
 * set decides which PAGE a link opens, never what anyone may do on it.
 */
export const CLOSING_MATRIX_EMAIL_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Super Admin",
  "SFE Manager",
  "CEO",
]);

export type ClosingEmailViewer = Pick<AccessContext, "role" | "scope">;

/**
 * The path the published-closing email's CTA sends `viewer` to.
 *
 * `canReadSales` is the caller's own `canAccess(access, "sales", "read")` — the same boundary the
 * admin and portal Closing pages enforce, passed in rather than re-read so this stays pure. A
 * viewer who fails it degrades to their landing page: a stale or mis-scoped click is never a 403
 * here, because the recipient of a published-month email should land somewhere useful, not on an
 * error.
 *
 * Only the PERIOD is passed to the portal tab. A portal viewer never picks a line — it is resolved
 * from their HR_ID — so forwarding one would be ignored at best and misleading at worst.
 */
export function resolveClosingPublishDestination(input: {
  viewer: ClosingEmailViewer;
  canReadSales: boolean;
  line?: string | null;
  period?: string | null;
}): string {
  const { viewer, canReadSales } = input;
  const line = String(input.line ?? "").trim();
  const period = String(input.period ?? "").trim();

  if (!canReadSales) return resolveLandingPathForRole(viewer.role);

  if (viewer.scope === "system" || CLOSING_MATRIX_EMAIL_ROLES.has(viewer.role)) {
    return withQuery("/sales/monthly-closing", { line, period });
  }

  if (canAccessPortalClosing(viewer)) {
    return withQuery("/employee-portals/monthly-closing", { period });
  }

  // Every other role, recipient or not: their normal landing page, unchanged.
  return resolveLandingPathForRole(viewer.role);
}

function withQuery(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}
