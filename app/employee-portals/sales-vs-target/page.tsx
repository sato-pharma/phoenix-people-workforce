import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { VsTargetDashboard } from "@/components/sales/vs-target/vs-target-dashboard-dynamic";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { buildVsTargetDashboard, type VsTargetDashboardData } from "@/lib/sales/vs-target-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sales vs Target — employee-portal twin of the admin-shell page at /sales/vs-target.
//
// This is the first sales surface a MEDICAL REP can open (owner decision 2026-08-04). Reps
// are bounded to rows the attribution engine resolved to them personally; see
// resolveVsTargetBound, which names the SELF case rather than letting it fall through to
// the line-wide bound every other sales scope helper would hand them.
//
// Both URLs share buildVsTargetDashboard, so the portal and the admin shell can never
// quote different numbers for the same viewer and month.
export default async function PortalSalesVsTargetPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  await assertPermission(access, "sales", "read");

  const sp = await searchParams;
  const data = await buildVsTargetDashboard(access, sp.period ?? null);

  // Badge and title are the sidebar's own section and label. The description names only the levels
  // THIS viewer can open: a Medical Rep gets areas, products and bricks, never team, region or rep.
  return (
    <EmployeePortalPageShell
      badge="Sales"
      description={describeScope(data)}
      errorBoundaryTitle="Sales vs Target unavailable"
      title="Sales vs Target"
    >
      {/* surface="portal": the dashboard drops its light command band and renders the figures,
          ring and month selector as portal cards under the standard navy shell hero above, so this
          page wears the one employee-portal identity. The admin twin at /sales/vs-target is
          unchanged. */}
      <VsTargetDashboard data={data} basePath="/employee-portals/sales-vs-target" kicker="Field Performance" surface="portal" />
    </EmployeePortalPageShell>
  );
}

/** "Your sales against your target, by area, product and brick." — the levels the dashboard offers. */
function describeScope(data: VsTargetDashboardData): string {
  const levels = [
    data.levels.team ? "team" : null,
    data.levels.region ? "region" : null,
    data.levels.area ? "area" : null,
    data.levels.rep ? "rep" : null,
    data.products.length > 0 ? "product" : null,
    data.levels.brick ? "brick" : null,
  ].filter((level): level is string => level != null);
  if (levels.length === 0) return "Your sales against your target.";
  if (levels.length === 1) return `Your sales against your target, by ${levels[0]}.`;
  return `Your sales against your target, by ${levels.slice(0, -1).join(", ")} and ${levels[levels.length - 1]}.`;
}
