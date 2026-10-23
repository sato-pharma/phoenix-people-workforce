/**
 * Pages a seat is FENCED OFF even though one of its grants would otherwise open them.
 *
 * Phoenix grants a KEY (`recruitment:read`, `attendance:read`, …) and a key opens every page cut
 * for it. That is right almost everywhere — but when the owner builds a seat by ticking pages one
 * at a time, he can want one page behind a key and not its neighbour. This list is the second half
 * of that choice: the pages a key carries in that the owner left OUT.
 *
 * The Talent Acquisition seat (`HR Resourcing`) was the first entry, built 2026-10-08 from
 * the owner's own ticks on the access blueprint. Every path below is a page one of her keys opens
 * that he did not tick. Each is EXACT — `/probation` closes the Probation Tracker and leaves
 * `/probation/dashboard` and `/probation/analytics`, which he ticked, open — except where a page's
 * own sub-pages are listed beside it.
 *
 * WHERE IT BITES. Two places read this, both on purpose:
 *   - `navigationItemVisible` (src/lib/navigation/active-path.ts) hides the row, in the sidebar,
 *     the hubs and the command palette alike;
 *   - `AppShell` sends a typed or bookmarked address back to the seat's home before the page
 *     renders, so a URL cannot walk past the hidden row.
 * The data behind a fenced page is reached through the same keys as the pages she DOES hold (the CV
 * Database lists the candidates the pipeline already shows her), so the page is the right grain.
 * Where a fenced page owns an API of its own — resolving a returned CV, minting a CV sheet link,
 * re-queuing an intake row, the CV Database template — the route calls `assertPageOpenForRole` as
 * well, so the address bar is not the only door that is shut.
 *
 * Deliberately dependency-free: active-path.ts is loaded by the unit-test harness without Next.
 */
import type { PhoenixRole } from "./permissions";

export const SEAT_PAGE_FENCES: Partial<Record<PhoenixRole, readonly string[]>> = {
  "HR Resourcing": [
    // Recruitment — carried in by recruitment:read / recruitment:export.
    "/cv-database",
    "/recruitment/returned-cvs",
    "/recruitment/intake-health",
    "/recruitment/contact-review",
    "/recruitment/cv-lifecycle-sheet",
    // Probation — the tracker. The dashboard and analytics are hers.
    "/probation",
    // Planning — carried in by weekly_plans:read. The Planning Calendar is hers.
    "/admin/weekly-plans",
    "/admin/approvals/plan",
    "/admin/field-workforce-compliance",
    "/admin/pm-products",
    // Attendance — carried in by attendance:read. Her own Fingerprint Report (My Workspace) is hers.
    "/attendance/analytics",
    "/attendance/disputes",
    "/attendance/employee-day-report",
    "/attendance/exceptions",
    "/attendance/fingerprint-report",
    "/attendance/weekly-review",
    // Leave — carried in by leave:create. Her own Request Vacation (My Workspace) is hers.
    "/leave-management/vacation-request",
    // Payroll — the Payslips Center, carried in by the payslips:read every seat holds for itself.
    // He did not tick it; her own payslip is on My Workspace.
    "/admin/payslips-center",
  ],
  // The HR Operations Specialist seat (`HR Administration`), built 2026-10-20 from the owner's
  // answers: she reviews attendance through her own Daily & Weekly Reports and never sees a salary,
  // so the company attendance pages (several price a day in EGP), Employee 360, the deduction pages
  // and the Payslips Center are closed to her even where a key she holds would open them. Her own
  // fingerprint report, payslip, deductions and vacation request stay on My Workspace.
  "HR Administration": [
    // Attendance — carried in by attendance:read and, for the fingerprint report, employees:read.
    "/attendance",
    // Employee 360 — carried in by employees:read; it shows pay.
    "/employee-360",
    // Deductions — the company tallies, priced in EGP.
    "/admin/daily-deductions",
    "/admin/deductions",
    // Leave — the company request desk. Her own Request Vacation (My Workspace) is hers.
    "/leave-management/vacation-request",
    // Payroll — the Payslips Center, carried in by the payslips:read every seat holds for itself.
    "/admin/payslips-center",
  ],
};

/** Fenced paths whose sub-pages are fenced too (a detail page of a fenced list). */
const FENCED_SUBTREES: Partial<Record<PhoenixRole, readonly string[]>> = {
  "HR Resourcing": ["/admin/approvals/plan", "/admin/field-workforce-compliance"],
  "HR Administration": ["/attendance", "/employee-360", "/admin/deductions"],
};

/** `/hr/probation?x=1` -> `/probation`. The `/hr` namespace serves the same pages. */
function normalizePagePath(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] || "/";
  const unprefixed = bare === "/hr" ? "/" : bare.startsWith("/hr/") ? bare.slice(3) : bare;
  return unprefixed.length > 1 ? unprefixed.replace(/\/+$/, "") : unprefixed;
}

export function isPageFencedForRole(role: PhoenixRole | null | undefined, path: string): boolean {
  if (!role) return false;
  const fenced = SEAT_PAGE_FENCES[role];
  if (!fenced?.length) return false;
  const page = normalizePagePath(path);
  if (fenced.includes(page)) return true;
  return (FENCED_SUBTREES[role] ?? []).some((root) => page.startsWith(`${root}/`));
}

/**
 * Where a page sends a seat it is fenced from: the seat's own landing page, or the employee portal
 * when that landing page is fenced too — never back into a fence, so it cannot loop. Null when the
 * page is open to the seat. guardSeatPage (seat-page-guard.ts) redirects on it; it lives here, apart
 * from Next, so the unit tests can call it.
 */
export function fencedPageRedirect(role: PhoenixRole | null | undefined, route: string, landing: string): string | null {
  if (!isPageFencedForRole(role, route)) return null;
  return isPageFencedForRole(role, landing) ? "/employee-portals" : landing;
}

/**
 * For an API route that belongs to ONE page: refuse the caller whose seat is fenced off that page.
 * Throws the `Forbidden:` error every route here already maps to a 403.
 */
export function assertPageOpenForRole(role: PhoenixRole | null | undefined, path: string): void {
  if (isPageFencedForRole(role, path)) {
    throw new Error(`Forbidden: ${role} is not given ${normalizePagePath(path)}.`);
  }
}

/**
 * Where a link to a fenced page should go instead: the sibling page that shows the same thing and
 * that the seat DOES hold. A fenced page with no entry here has no honest substitute, and the
 * caller drops the link rather than offering an address that would bounce.
 */
const FENCED_PAGE_SIBLINGS: Readonly<Record<string, string>> = {
  // The CV Database lists the candidates the Recruitment pipeline already shows her.
  "/cv-database": "/recruitment",
  // The tracker's cases are the Decision Dashboard's cases.
  "/probation": "/probation/dashboard",
  "/admin/weekly-plans": "/admin/weekly-plans/calendar",
};

/**
 * `href` itself when the role may open it, the sibling page when it is fenced and has one, and
 * null when it is fenced and has none. Keeps the `/hr` prefix; drops a query, which belonged to the
 * fenced page.
 */
export function hrefOutsideSeatFence(role: PhoenixRole | null | undefined, href: string): string | null {
  if (!isPageFencedForRole(role, href)) return href;
  const sibling = FENCED_PAGE_SIBLINGS[normalizePagePath(href)];
  if (!sibling) return null;
  return href === "/hr" || href.startsWith("/hr/") ? `/hr${sibling}` : sibling;
}
