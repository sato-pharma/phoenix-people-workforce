import { redirect } from "next/navigation";
import { Suspense } from "react";

import { PortalWeeklyDashboard } from "@/components/sales/weekly/portal-weekly-dashboard";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import {
  assertPermission,
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getPortalWeeklyDashboard,
  toPortalWeeklyScopeView,
  type PortalWeeklyComparison,
  type PortalWeeklyFilters,
  type PortalWeeklyScopeView,
} from "@/lib/sales/weekly/portal-weekly-dashboard";
import type { WeeklyDashboard } from "@/lib/sales/weekly/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Company-scope re-host of the portal Weekly Sales dashboard for the CEO / Super Admin.
// The loader resolves scope from the SESSION (CEO / Super Admin ⇒ full tier: all lines,
// all regions, restricted products visible), so this page adds no widening of its own —
// it only hosts the same dashboard the field roles use, inside the admin shell.

function parseFilters(params: { [key: string]: string | string[] | undefined }): PortalWeeklyFilters {
  const list = (value: string | string[] | undefined): string[] => {
    if (Array.isArray(value)) return value.flatMap((part) => part.split(",")).map((p) => p.trim()).filter(Boolean);
    if (typeof value === "string") return value.split(",").map((p) => p.trim()).filter(Boolean);
    return [];
  };
  const intList = (value: string | string[] | undefined): number[] => {
    return list(value)
      .map((p) => parseInt(p, 10))
      .filter((n) => !Number.isNaN(n));
  };
  const mode = (value: string | string[] | undefined): "include" | "exclude" => {
    const raw = Array.isArray(value) ? value[0] : value;
    return raw?.trim() === "exclude" ? "exclude" : "include";
  };
  return {
    cycleMonths: list(params.months),
    cycleMonthMode: mode(params.monthsMode),
    weekNumbers: intList(params.weeks),
    weekNumberMode: mode(params.weeksMode),
    distributorCodes: list(params.distributors),
    distributorFilterMode: mode(params.distributorsMode),
    regionCodes: list(params.regions),
    regionFilterMode: mode(params.regionsMode),
    productCodes: list(params.products),
    productFilterMode: mode(params.productsMode),
    lineCodes: list(params.lines),
    lineFilterMode: mode(params.linesMode),
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

async function CompanyWeeklyContent({
  access,
  filters,
}: {
  access: AccessContext;
  filters: PortalWeeklyFilters;
}) {
  let data: WeeklyDashboard | null = null;
  let scope: PortalWeeklyScopeView | null = null;
  let comparison: PortalWeeklyComparison | null = null;
  let loadError: string | null = null;
  try {
    const result = await getPortalWeeklyDashboard(filters, access);
    data = result.data;
    scope = toPortalWeeklyScopeView(result.scope);
    comparison = result.comparison;
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load Weekly Sales.";
  }

  if (data && scope) {
    return (
      <PortalWeeklyDashboard
        initialData={data}
        scope={scope}
        initialComparison={comparison}
      />
    );
  }

  return (
    <FieldSalesUnavailable
      title="Weekly Sales unavailable"
      message={loadError ?? "No Weekly Sales data is available yet. This is a data-source state, not a zero."}
    />
  );
}

export default async function CompanyWeeklySalesPage({
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
          <p className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-phx-accent">Field Sales · Company Scope</p>
          <h1 className="text-2xl font-bold leading-tight text-foreground">Weekly Sales</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            De-cumulated weekly distributor sell-in across every line and region — value, units, products
            and week-over-week trends. Same live dashboard the field managers use, at company scope.
          </p>
        </div>
      </div>

      <Suspense
        fallback={
          <AppRouteLoadingState
            title="Loading Weekly Sales"
            description="Aggregating company-wide weekly sell-in."
          />
        }
      >
        <CompanyWeeklyContent access={access} filters={filters} />
      </Suspense>
    </div>
  );
}
