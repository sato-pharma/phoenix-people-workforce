import { Suspense } from "react";
import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";
import { PortalWeeklyDashboard } from "@/components/sales/weekly/portal-weekly-dashboard";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getPortalWeeklyDashboard,
  isPortalWeeklyRole,
  toPortalWeeklyScopeView,
  type PortalWeeklyComparison,
  type PortalWeeklyFilters,
  type PortalWeeklyScopeView,
} from "@/lib/sales/weekly/portal-weekly-dashboard";
import type { WeeklyDashboard } from "@/lib/sales/weekly/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

async function PortalWeeklyContent({
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
    <EmployeePortalEmptyState
      message={loadError ?? "No Weekly Sales data is available for your scope yet."}
      title="Weekly Sales unavailable"
    />
  );
}

export default async function PortalWeeklySalesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!isPortalWeeklyRole(access.role)) {
    redirect(resolveLandingPathForRole(access.role));
  }
  await assertPermission(access, "sales", "read");

  const filters = parseFilters(await searchParams);

  return (
    <EmployeePortalPageShell
      badge="Sales Operations"
      description="De-cumulated weekly distributor sell-in across your scope — value, units, regions, products and week-over-week trends."
      errorBoundaryTitle="Weekly Sales unavailable"
      title="Weekly Sales"
    >
      <Suspense fallback={<DashboardSkeleton kpiCount={4} chartCount={2} />}>
        <PortalWeeklyContent access={access} filters={filters} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}
