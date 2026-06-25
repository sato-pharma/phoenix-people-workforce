import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { AnalyticsDemoBanner } from "@/components/analytics/analytics-demo-banner";
import { AnalyticsModuleNav } from "@/components/analytics/analytics-module-nav";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  loadAnalyticsDimensions,
  loadClosingByEmployee,
  type AnalyticsDimensions,
  type ClosingByEmployeeRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { CLOSING_FILTERS } from "@/lib/analytics/sales-filter-config";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoClosingByEmployee } from "@/lib/analytics/demo-fixtures";
import { CLOSING_TABS } from "@/lib/analytics/module-nav-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function ByEmployeeContent({
  searchParams,
  role,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
}) {
  const demo = isAnalyticsDemoMode(searchParams);
  const filters = parseAnalyticsFilters(searchParams, CLOSING_FILTERS);

  const closingFilters = {
    period:       typeof filters.period       === "string" ? filters.period       : null,
    periodFrom:   typeof filters.periodFrom   === "string" ? filters.periodFrom   : null,
    periodTo:     typeof filters.periodTo     === "string" ? filters.periodTo     : null,
    lines:        Array.isArray(filters.lines)             ? filters.lines         : [],
    products:     Array.isArray(filters.products)          ? filters.products      : [],
    families:     Array.isArray(filters.families)          ? filters.families      : [],
    employeeHrId: typeof filters.employeeHrId === "string" ? filters.employeeHrId : null,
    territory:    typeof filters.territory    === "string" ? filters.territory    : null,
    batchStatus:  Array.isArray(filters.batchStatus)        ? filters.batchStatus  : [],
    batchId:      typeof filters.batchId      === "string" ? filters.batchId      : null,
  };

  let rows: ClosingByEmployeeRow[];
  let dimensions: AnalyticsDimensions;

  if (demo) {
    rows = demoClosingByEmployee();
    dimensions = demoAnalyticsDimensions();
  } else {
    [rows, dimensions] = await Promise.all([
      loadClosingByEmployee(closingFilters).catch(() => []),
      loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions()),
    ]);
  }

  const totalSales  = rows.reduce((s, r) => s + r.salesValue,  0);
  const totalTarget = rows.reduce((s, r) => s + r.targetValue, 0);

  return (
    <div className="space-y-5">
      {demo ? <AnalyticsDemoBanner /> : null}

      <AnalyticsFilterBar
        descriptors={CLOSING_FILTERS}
        values={filters}
        dimensions={dimensions}
        basePath="/admin/analytics/monthly-closing/by-employee"
      />

      <AnalyticsSection title="Employee Performance" count={rows.length}>
        {rows.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["employeeName", "employeeHrId", "territory", "line"]}
            columns={[
              { key: "period",         label: "Period",    sortable: true },
              { key: "line",           label: "Line",      sortable: true },
              { key: "employeeHrId",   label: "HR ID",     sortable: true },
              { key: "employeeName",   label: "Name",      sortable: true },
              { key: "managerHrId",    label: "Manager" },
              { key: "territory",      label: "Territory", sortable: true },
              { key: "salesValue",     label: "Sales (EGP)",  align: "right", sortable: true, formatKind: "number" },
              { key: "targetValue",    label: "Target (EGP)", align: "right", sortable: true, formatKind: "number" },
              { key: "achievementPct", label: "Achiev %",  align: "right", sortable: true, formatKind: "percent" },
            ]}
            rows={rows}
            totals={{ salesValue: totalSales, targetValue: totalTarget }}
            exportTitle="Closing By Employee"
            exportSubtitle="Monthly closing performance per employee"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export default async function ClosingByEmployeePage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="w-1 h-12 bg-[#F97316] shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#F97316] mb-0.5">Closing</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Closing — By Employee</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Individual employee performance: sales vs target, territory, and achievement %.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={CLOSING_TABS} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ByEmployeeContent searchParams={resolvedParams} role={access.role} />
      </Suspense>
    </div>
  );
}
