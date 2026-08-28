import { redirect } from "next/navigation";
import { Suspense } from "react";

import { PortalSosDashboard } from "@/components/sales/portal/portal-sos-dashboard";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import {
  assertPermission,
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getPortalSosDashboard,
  toPortalSosScopeView,
  type PortalSosComparison,
  type PortalSosScopeView,
} from "@/lib/sales/portal-sos-dashboard";
import type { DistributorUploadStatus } from "@/lib/sales/monthly-distributor-import";
import type { SosDashboardData, SosDashboardFilters } from "@/lib/sales/sos-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Company-scope re-host of the portal Source-of-Sales dashboard for the CEO / Super Admin.
// Scope resolves from the SESSION inside getPortalSosDashboard (CEO / Super Admin ⇒ COMPANY:
// no line/region/product restriction), so this page adds no widening of its own — it hosts
// the same dashboard the field roles use, inside the admin shell.

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

function FieldSalesUnavailable({ message, title }: { message: string; title: string }) {
  return (
    <div className="border border-amber-200 bg-amber-50 px-5 py-4">
      <p className="text-sm font-black text-amber-900">{title}</p>
      <p className="mt-1 text-xs font-medium text-amber-800">{message}</p>
    </div>
  );
}

async function CompanySosContent({
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
    <FieldSalesUnavailable
      title="Source of Sales unavailable"
      message={loadError ?? "No Source of Sales data is available yet. This is a data-source state, not a zero."}
    />
  );
}

export default async function CompanySourceOfSalesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  if (!(access.role === "CEO" || canAccessSystemAdministratorWorkspace(access))) {
    redirect("/admin");
  }
  await assertPermission(access, "sales", "read");

  const filters = parseFilters(await searchParams);

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-6">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="h-12 w-1 shrink-0 bg-phx-accent" />
        <div>
          <p className="mb-0.5 text-phx-2xs font-bold uppercase tracking-widest text-phx-accent">Field Sales · Company Scope</p>
          <h1 className="text-2xl font-bold leading-tight text-foreground">Source of Sales</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Monthly distributor sell-in across the whole company — value, units, channel mix, regions,
            areas, products and distributors. Same live dashboard the field managers use, at company scope.
          </p>
        </div>
      </div>

      <Suspense
        fallback={
          <AppRouteLoadingState
            title="Loading Source of Sales"
            description="Aggregating company-wide monthly sell-in."
          />
        }
      >
        <CompanySosContent access={access} filters={filters} />
      </Suspense>
    </div>
  );
}
