import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { PORTAL_WEEKLY_ROLES } from "@/lib/sales/weekly/portal-weekly-dashboard";

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Sales — who may read the TERRITORY views.
//
// `weekly_sales:read` cannot answer that on its own. The matrix grants it to Medical Rep too, and a
// rep's weekly scope (resolveWeeklyAccessScope) is his whole line across his whole region: the seat
// area bound applies to managers' seats, never to a rep. So a door that serves the territory views
// on that permission alone hands a rep his line's numbers for his whole region, depot branch by
// branch and distributor by distributor; the analytics pages and the two management workbooks also
// name the region's other areas with their figures, and the workbooks name his managers. No other
// rep's name appears in any of them (measured 2026-09-16).
//
// The owner's rule (2026-09-16, after the Source of Sales precedent of 2026-09-14): a rep sees his
// own area's weekly sales on his own portal screen (portal-weekly-rep.ts) and nothing wider — no
// other rep's name or number, no region or distributor dashboard, no export.
//
// The doors that call this: the admin dashboard API (/api/sales/weekly/dashboard), its BI workbook
// (/export), the Summarized Report (/summary-export), the NSM/DSM workbook (/nsm-dsm-export), and the
// portal Sales Analytics weekly pages. They admit the managers' portal roles and the three admin-shell
// roles that hold the grant, and refuse everyone else. It fails closed on purpose: a role granted
// `weekly_sales:read` later gets nothing here until someone decides it should.
//
// Medical Rep keeps the grant itself. What it still opens for him: the admin weekly stock feed and its
// workbook, which load the same payload as his own portal Weekly Stock screen and its download (one
// loader, scoped from the session), and the weekly column-profile change log, which holds no figures.
// ─────────────────────────────────────────────────────────────────────────────

export const WEEKLY_TERRITORY_VIEWER_ROLES = [
  ...PORTAL_WEEKLY_ROLES,
  "SFE Manager",
  "CEO",
  "Super Admin",
] as const satisfies readonly PhoenixRole[];

const WEEKLY_TERRITORY_VIEWER_ROLE_SET = new Set<PhoenixRole>(WEEKLY_TERRITORY_VIEWER_ROLES);

export function isWeeklyTerritoryViewerRole(role: PhoenixRole): boolean {
  return WEEKLY_TERRITORY_VIEWER_ROLE_SET.has(role);
}

/**
 * Call right after `assertPermission(access, "weekly_sales", "read")` and before any rate limit or
 * load. The message starts with "Forbidden:" because that prefix is what every weekly route's catch
 * turns into a 403 (isForbiddenError in src/lib/auth/server.ts).
 */
export function assertWeeklyTerritoryViewer(access: Pick<AccessContext, "role">): void {
  if (isWeeklyTerritoryViewerRole(access.role)) return;
  throw new Error(`Forbidden: ${access.role} cannot read the weekly territory dashboard.`);
}
