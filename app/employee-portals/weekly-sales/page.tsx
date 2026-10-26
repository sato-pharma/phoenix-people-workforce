import { Suspense } from "react";
import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";
import { PortalWeeklyDashboard } from "@/components/sales/weekly/portal-weekly-dashboard";
import { PortalWeeklyRepView } from "@/components/sales/weekly/portal-weekly-rep-view";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { toWeeklyCycleMonth } from "@/lib/sales/periods";
import {
  getPortalWeeklyDashboard,
  isPortalWeeklyRole,
  toPortalWeeklyScopeView,
  type PortalWeeklyComparison,
  type PortalWeeklyFilters,
  type PortalWeeklyScopeView,
} from "@/lib/sales/weekly/portal-weekly-dashboard";
import type { PortalWeeklyFieldForce } from "@/lib/sales/weekly/portal-weekly-field-force";
import {
  getPortalWeeklyRepSales,
  isPortalWeeklyRepRole,
  type PortalWeeklyRepSales,
} from "@/lib/sales/weekly/portal-weekly-rep";
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
    // A deep link may spell the month "2026-10"; the weekly tables key it "2026-10-01".
    cycleMonths: list(params.months).map(toWeeklyCycleMonth),
    cycleMonthMode: mode(params.monthsMode),
    // First paint opens on the newest month that has started, not on "All months" (the API route never
    // sets this, so clearing the month on the screen still means all of them).
    defaultToLatestStartedMonth: true,
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
  let fieldForce: PortalWeeklyFieldForce | null = null;
  let loadError: string | null = null;
  try {
    const result = await getPortalWeeklyDashboard(filters, access, { includeFieldForce: true });
    data = result.data;
    scope = toPortalWeeklyScopeView(result.scope);
    comparison = result.comparison;
    fieldForce = result.fieldForce;
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load Weekly Sales.";
  }

  if (data && scope) {
    return (
      <PortalWeeklyDashboard
        initialData={data}
        scope={scope}
        initialComparison={comparison}
        initialFieldForce={fieldForce}
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

/**
 * A Medical Rep's own screen. His data is narrowed to his own seat on the server
 * (getPortalWeeklyRepSales); the managers' dashboard, its API and its export still refuse him.
 */
async function PortalWeeklyRepContent({ access, month }: { access: AccessContext; month: string | null }) {
  let payload: PortalWeeklyRepSales | null = null;
  let loadError: string | null = null;
  try {
    payload = await getPortalWeeklyRepSales(access, { month });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load Weekly Sales.";
  }

  if (payload) return <PortalWeeklyRepView data={payload} />;

  return (
    <EmployeePortalEmptyState
      message={loadError ?? "No Weekly Sales data is available for your area yet."}
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
  const isRep = isPortalWeeklyRepRole(access.role);
  if (!isRep && !isPortalWeeklyRole(access.role)) {
    redirect(resolveLandingPathForRole(access.role));
  }
  await assertPermission(access, "sales", "read");

  const params = await searchParams;

  if (isRep) {
    const rawMonth = Array.isArray(params.month) ? params.month[0] : params.month;
    return (
      <EmployeePortalPageShell
        badge="Sales Operations"
        description="Your own area's sales week by week, per product — an early read ahead of the Monthly Closing."
        errorBoundaryTitle="Weekly Sales unavailable"
        title="Weekly Sales"
      >
        <Suspense fallback={<DashboardSkeleton kpiCount={4} chartCount={1} />}>
          <PortalWeeklyRepContent access={access} month={rawMonth?.trim() || null} />
        </Suspense>
      </EmployeePortalPageShell>
    );
  }

  const filters = parseFilters(params);

  return (
    <EmployeePortalPageShell
      badge="Sales Operations"
      description="Your medical reps week by week, per product — plus the de-cumulated distributor sell-in behind it."
      errorBoundaryTitle="Weekly Sales unavailable"
      title="Weekly Sales"
    >
      <Suspense fallback={<DashboardSkeleton kpiCount={4} chartCount={2} />}>
        <PortalWeeklyContent access={access} filters={filters} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}
