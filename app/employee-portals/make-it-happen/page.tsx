import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MakeItHappenPlanner } from "@/components/sales/make-it-happen/make-it-happen-planner";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canUseMakeItHappen } from "@/lib/sales/make-it-happen/scope";
import { buildMakeItHappenWorkspace } from "@/lib/sales/make-it-happen/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Make It Happen — employee-portal twin of /sales/make-it-happen. Both share
// buildMakeItHappenWorkspace, so the two shells can never plan against different numbers.
export default async function PortalMakeItHappenPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; period?: string; rep?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  await assertPermission(access, "sales", "read");
  if (!canUseMakeItHappen(access.role)) redirect("/employee-portals");

  const sp = await searchParams;
  const data = await buildMakeItHappenWorkspace(access, { kind: sp.kind, period: sp.period, rep: sp.rep });

  // Badge and title are the sidebar's own section and label.
  return (
    <EmployeePortalPageShell
      badge="Sales"
      description="Plan the units that reach your target, product by product."
      errorBoundaryTitle="Make It Happen unavailable"
      title="Make It Happen"
    >
      {/* surface="portal": the planner drops its light command band for the portal identity under
          the standard navy shell hero. The admin twin at /sales/make-it-happen is unchanged. */}
      <MakeItHappenPlanner
        key={`${data.periodKind}|${data.periodKey}|${data.viewingRep?.key ?? ""}`}
        basePath="/employee-portals/make-it-happen"
        data={data}
        kicker="Field Performance"
        surface="portal"
      />
    </EmployeePortalPageShell>
  );
}
