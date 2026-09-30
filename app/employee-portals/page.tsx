import { redirect } from "next/navigation";

import { PortalCommandCenter } from "@/components/employee-portal/portal-command-center";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { getPortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import { loadRepTodayPlan } from "@/lib/phoenix-crm/server/rep-landing";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { isForbiddenError } from "@/lib/auth/server";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * `?kpiMonth=YYYY-MM` — the month the Medical Rep's keycards are showing.
 *
 * It rides in the URL rather than in component state, for the same reason the KPIs board's whole
 * selection does: every change re-runs the gates above server-side, so no month can be picked past
 * the access check, and the back button and a pasted link both work. The value is handed over RAW —
 * `getPortalHomeSnapshot` validates it against the one month list and falls back to the running
 * month — so there is deliberately no second opinion here about what a month may be.
 */
type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** First value only: a repeated `?kpiMonth=a&kpiMonth=b` must resolve to one month, not an array. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function EmployeePortalsHomePage({ searchParams }: PageProps) {
  const access = await resolveAuthenticatedPageAccess();
  const mode = resolveNavigationMode(access);

  if (mode !== "employee-portal") {
    redirect("/overview");
  }
  // The Training Manager used to be bounced into the coaching dashboard here. That whole section is
  // now hidden from the portal (owner, 2026-09-29: hide training manager + coaching system-wide), so
  // a Training Manager lands on the normal portal home like every other portal role.
  try {
    await assertPermission(access, "employee_profile", "read");
  } catch (error) {
    if (isForbiddenError(error)) redirect("/login");
    throw error;
  }

  const params = (await searchParams) ?? {};

  let snapshot;
  try {
    snapshot = await getPortalHomeSnapshot(access, { kpiMonth: one(params.kpiMonth) });
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals", module: "home-snapshot", role: access.role, hrId: access.hrId },
      error,
    );
    return (
      <EmployeePortalEmptyState
        message="Your command center is temporarily unavailable. Please try again in a moment."
        title="Portal Unavailable"
      />
    );
  }

  // The rep's day, which replaced the Phoenix CRM Today module (owner, 2026-09-30). It never throws
  // — a closed line, a missing permission or a failed read all answer null and the panel renders
  // nothing, because a landing page that fails to paint over one panel is worse than one panel short.
  const repTodayPlan = await loadRepTodayPlan(access);

  return <PortalCommandCenter access={access} repTodayPlan={repTodayPlan} snapshot={snapshot} />;
}
