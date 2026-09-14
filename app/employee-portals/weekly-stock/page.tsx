import { Suspense } from "react";
import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";
import { WeeklyStockDashboard } from "@/components/sales/weekly/weekly-stock-dashboard";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  isPortalWeeklyStockRole,
  loadWeeklyStockDashboard,
  type WeeklyStockPayload,
} from "@/lib/sales/weekly/stock-dashboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function PortalWeeklyStockContent({ access }: { access: AccessContext }) {
  let payload: WeeklyStockPayload | null = null;
  let loadError: string | null = null;
  try {
    payload = await loadWeeklyStockDashboard({}, access);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load Weekly Stock.";
  }

  if (payload) {
    return (
      <WeeklyStockDashboard
        initial={payload}
        feedPath="/api/employee-portals/weekly-stock"
        exportPath="/api/employee-portals/weekly-stock/export"
      />
    );
  }

  return (
    <EmployeePortalEmptyState
      message={loadError ?? "No Weekly Stock data is available for your scope yet."}
      title="Weekly Stock unavailable"
    />
  );
}

export default async function PortalWeeklyStockPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!isPortalWeeklyStockRole(access.role)) {
    redirect(resolveLandingPathForRole(access.role));
  }
  await assertPermission(access, "sales", "read");

  return (
    <EmployeePortalPageShell
      badge="Sales Operations"
      description="Stock on hand for every product at every depot in your scope, with weeks of cover from recent sales."
      errorBoundaryTitle="Weekly Stock unavailable"
      title="Weekly Stock"
    >
      <Suspense fallback={<DashboardSkeleton kpiCount={4} chartCount={1} />}>
        <PortalWeeklyStockContent access={access} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}
