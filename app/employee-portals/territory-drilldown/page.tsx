import { Suspense } from "react";
import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";
import { TerritorySyncPanel } from "@/components/sales/territory/territory-sync-panel";
import { TerritoryTreeExplorer } from "@/components/sales/territory/territory-tree-explorer";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getTerritorySkeleton, isTerritoryDrilldownRole } from "@/lib/sales/territory/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function TerritoryDrilldownContent({ access }: { access: AccessContext }) {
  const skeleton = await getTerritorySkeleton(access);

  if (skeleton.diagnostic) {
    return (
      <EmployeePortalEmptyState message={skeleton.diagnostic.message} title="Territory not available yet" />
    );
  }

  return <TerritoryTreeExplorer skeleton={skeleton} />;
}

export default async function TerritoryDrilldownPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!isTerritoryDrilldownRole(access.role)) {
    redirect(resolveLandingPathForRole(access.role));
  }
  await assertPermission(access, "sales", "read");

  return (
    <EmployeePortalPageShell
      badge="Sales Operations"
      description="Region down to the pharmacies buying — expand any block to see exactly where your number comes from, by name, never by code."
      errorBoundaryTitle="Territory drilldown unavailable"
      title="Territory & Sales Drilldown"
    >
      <div className="mb-4">
        <TerritorySyncPanel canRun={access.role === "Super Admin" || access.scope === "system"} />
      </div>
      <Suspense fallback={<DashboardSkeleton chartCount={1} kpiCount={0} />}>
        <TerritoryDrilldownContent access={access} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}
