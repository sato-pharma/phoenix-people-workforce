import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { VsTargetDashboard } from "@/components/sales/vs-target/vs-target-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { buildVsTargetDashboard } from "@/lib/sales/vs-target-page";

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

  return (
    <EmployeePortalPageShell
      badge="Field Performance"
      description="Your sales against your target, by team, region, area, rep and brick."
      errorBoundaryTitle="Sales vs Target unavailable"
      // The dashboard renders its own command band, which carries the headline figures and the
      // month selector. Suppress the shell's standard banner so the page does not open with two
      // stacked dark headers saying the same thing.
      hero={<></>}
      title="Sales vs Target"
    >
      <VsTargetDashboard data={data} basePath="/employee-portals/sales-vs-target" kicker="Field Performance" />
    </EmployeePortalPageShell>
  );
}
