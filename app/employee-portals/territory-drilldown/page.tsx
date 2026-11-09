import { Suspense } from "react";
import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";
import { TerritoryLinePicker } from "@/components/sales/territory/territory-line-picker";
import { TerritorySyncPanel } from "@/components/sales/territory/territory-sync-panel";
import { TerritoryTreeExplorer } from "@/components/sales/territory/territory-tree-explorer";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getTerritorySkeleton,
  isTerritoryDrilldownRole,
  isTerritoryLinePickerRole,
  TERRITORY_PICKER_LINES,
} from "@/lib/sales/territory/service";
import { territoryWindowNote } from "@/lib/sales/territory/window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function TerritoryDrilldownContent({
  access,
  selectedLine,
}: {
  access: AccessContext;
  selectedLine: string | null;
}) {
  const skeleton = await getTerritorySkeleton(access, selectedLine);

  if (skeleton.diagnostic) {
    return (
      <EmployeePortalEmptyState message={skeleton.diagnostic.message} title="Sales Drilldown not available yet" />
    );
  }

  // Super Admin / CEO see every line, so they pick which line to drill (skeleton.officialLine is
  // the resolved pick). Every other role drills its own derived line and gets no picker.
  const showLinePicker = isTerritoryLinePickerRole(access.role);

  return (
    <div className="space-y-4">
      {showLinePicker ? (
        <TerritoryLinePicker activeLine={skeleton.officialLine} lines={TERRITORY_PICKER_LINES} />
      ) : null}
      {skeleton.window ? (
        <p className="text-phx-xs font-semibold text-slate-600">{territoryWindowNote(skeleton.window)}</p>
      ) : null}
      <TerritoryTreeExplorer skeleton={skeleton} />
    </div>
  );
}

export default async function TerritoryDrilldownPage({
  searchParams,
}: {
  searchParams: Promise<{ line?: string | string[] }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!isTerritoryDrilldownRole(access.role)) {
    redirect(resolveLandingPathForRole(access.role));
  }
  await assertPermission(access, "sales", "read");

  const lineParam = (await searchParams)?.line;
  const selectedLine = Array.isArray(lineParam) ? (lineParam[0] ?? null) : (lineParam ?? null);

  return (
    <EmployeePortalPageShell
      badge="Sales"
      description="From your region down to the pharmacies buying. Open any block to see where your number comes from, by name."
      errorBoundaryTitle="Sales Drilldown unavailable"
      title="Sales Drilldown"
    >
      <Suspense fallback={<DashboardSkeleton chartCount={1} kpiCount={0} />}>
        <TerritoryDrilldownContent access={access} selectedLine={selectedLine} />
      </Suspense>
      {/* Under the tree, not above it: the page opens on the viewer's own territory, and the data
          sync is the housekeeping beneath it. Every role that can open this page is a Territory
          Drilldown role, and by owner decision all of them may run the (corrective, idempotent)
          sync — so the button is always live here. The per-line reconciliation chips are narrower:
          they cover every line the sync touched, not just this viewer's own, so only a role that
          already sees every line company-wide (the line-picker roles) gets to see them. */}
      <div className="mt-4">
        <TerritorySyncPanel canRun showReconciliation={isTerritoryLinePickerRole(access.role)} />
      </div>
    </EmployeePortalPageShell>
  );
}
