import { Suspense } from "react";
import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";
import { PortalSosDashboard } from "@/components/sales/portal/portal-sos-dashboard";
import { PortalSosPharmacyActions } from "@/components/sales/portal/portal-sos-pharmacy-actions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getPortalSosDashboard,
  isPortalSosActionsRole,
  isPortalSosRole,
  toPortalSosScopeView,
  type PortalSosComparison,
  type PortalSosScopeView,
} from "@/lib/sales/portal-sos-dashboard";
import type { DistributorUploadStatus } from "@/lib/sales/monthly-distributor-import";
import type { SosDashboardData, SosDashboardFilters } from "@/lib/sales/sos-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function parseFilters(params: { [key: string]: string | string[] | undefined }): SosDashboardFilters {
  const first = (value: string | string[] | undefined): string | undefined => {
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  };
  const list = (value: string | string[] | undefined): string[] => {
    if (Array.isArray(value)) return value.flatMap((part) => part.split(",")).map((p) => p.trim()).filter(Boolean);
    if (typeof value === "string") return value.split(",").map((p) => p.trim()).filter(Boolean);
    return [];
  };
  return {
    period: first(params.period),
    lines: list(params.lines),
    distributors: list(params.distributors),
    regions: list(params.regions),
    areas: list(params.areas),
    products: list(params.products),
  };
}

async function PortalSosContent({
  access,
  filters,
}: {
  access: AccessContext;
  filters: SosDashboardFilters;
}) {
  let data: SosDashboardData | null = null;
  let scope: PortalSosScopeView | null = null;
  let comparison: PortalSosComparison | null = null;
  let uploadStatus: DistributorUploadStatus | null = null;
  let loadError: string | null = null;
  try {
    const result = await getPortalSosDashboard(filters, access);
    data = result.data;
    scope = toPortalSosScopeView(result.scope);
    comparison = result.comparison;
    uploadStatus = result.uploadStatus;
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load Source of Sales.";
  }

  if (data && scope) {
    return (
      <PortalSosDashboard
        initialData={data}
        scope={scope}
        initialComparison={comparison}
        initialUploadStatus={uploadStatus}
      />
    );
  }

  return (
    <EmployeePortalEmptyState
      message={loadError ?? "No Source of Sales data is available for your scope yet."}
      title="Source of Sales unavailable"
    />
  );
}

export default async function PortalSourceOfSalesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!isPortalSosActionsRole(access.role)) {
    redirect(resolveLandingPathForRole(access.role));
  }
  await assertPermission(access, "sales", "read");

  // A Medical Rep gets the pharmacy action lists for his own area and nothing else: the distributor
  // dashboard resolves him at region level, which would show him his sibling reps' areas.
  const showDistributorDashboard = isPortalSosRole(access.role);
  const filters = parseFilters(await searchParams);
  const description = showDistributorDashboard
    ? "Which pharmacies stopped, dropped or started buying in your published closings, how this month is pacing, and the distributor sell-in behind it."
    : "Which pharmacies in your area stopped, dropped or started buying in your published closings, and how this month is pacing.";

  return (
    <EmployeePortalPageShell
      badge="Sales Operations"
      description={description}
      errorBoundaryTitle="Source of Sales unavailable"
      // The pharmacy action lists open with the shared light command band (as Sales vs Target,
      // Targets and Make It Happen do); the shell's dark banner would repeat it.
      hero={<></>}
      title="Source of Sales"
    >
      <div className="space-y-6">
        <PortalSosPharmacyActions subtitle={description} />
        {showDistributorDashboard ? (
          <Suspense fallback={<DashboardSkeleton kpiCount={4} chartCount={2} />}>
            <PortalSosContent access={access} filters={filters} />
          </Suspense>
        ) : null}
      </div>
    </EmployeePortalPageShell>
  );
}
