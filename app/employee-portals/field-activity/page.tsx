import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { FieldActivityView } from "@/components/field-activity/field-activity-view";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveFieldActivityAccess } from "@/lib/field-activity/access";
import { defaultPeriod } from "@/lib/field-activity/period";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Field Activity, the PORTAL half.
 *
 * 🔴 WHY THIS PAGE EXISTS. The module shipped with one page, under `/admin/`, and a catalog row in
 * the portal seeds pointing at it. `app/(admin)/layout.tsx` redirects every portal-mode viewer out
 * of that route group before the page runs, so the five field seats the module was built for — DM,
 * RM, NSM, PM, GPM — could not reach it by the sidebar OR by typing the address. Only the three
 * admin-mode seats (SFE Manager, Super Admin, CEO) ever saw it.
 *
 * The two pages are deliberately thin and share everything that decides anything: the same
 * `resolveFieldActivityAccess` gate, the same `FieldActivityView`, the same API behind it. Neither
 * can drift into being more permissive than the other, because neither one decides.
 */
export default async function FieldActivityPortalPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");

  // The matrix grant, stated here rather than only inside the helper. Two reasons: the sidebar
  // registry records this exact permission for the row, and tests/employee-portal-nav-permission-
  // matches-page pins the two together — a registry that claims a grant its page never checks is
  // drift, and the guard is right to refuse it. It also matches the sibling DV pages, which name
  // their grant in their own source.
  if (!(await canAccess(access, "double_visit_analytics", "read"))) redirect(resolveLandingPathForRole(access.role));

  // Then the module's own gate: the role list AND the viewer's org-tree scope, failing closed.
  // Hiding the sidebar row is UX; this is the boundary, and the API re-applies it per request.
  const resolved = await resolveFieldActivityAccess(access);
  if (!resolved) redirect(resolveLandingPathForRole(access.role));

  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const period = defaultPeriod(todayIso);

  return (
    <EmployeePortalPageShell
      badge="Coaching"
      description="One person's field days end to end — every stop, its GPS, the clock on the door against the clock on the log, and the outstation claim that sits against them."
      errorBoundaryTitle="Field Activity unavailable"
      title="Field Activity"
    >
      {/* `chrome="portal"` because THIS shell owns the header above — without it the view drew its
          own `<h1>Field Activity</h1>` and the module sentence a second time. */}
      <FieldActivityView chrome="portal" defaultFrom={period.fromIso} defaultTo={period.toIso} />
    </EmployeePortalPageShell>
  );
}
