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
import { canViewHeadOfficeLine } from "@/lib/sales/access-scope";
import {
  loadAnalyticsDimensions,
  loadSosByCustomer,
  type AnalyticsDimensions,
  type SosByCustomerRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { SOS_FILTERS } from "@/lib/analytics/sales-filter-config";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoSosByCustomer } from "@/lib/analytics/demo-fixtures";
import { SOS_TABS } from "@/lib/analytics/module-nav-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function ByCustomerContent({
  searchParams,
  role,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
}) {
  const demo = isAnalyticsDemoMode(searchParams);
  const filters = parseAnalyticsFilters(searchParams, SOS_FILTERS);

  const sosFilters = {
    period:       typeof filters.period      === "string" ? filters.period      : null,
    periodFrom:   typeof filters.periodFrom  === "string" ? filters.periodFrom  : null,
    periodTo:     typeof filters.periodTo    === "string" ? filters.periodTo    : null,
    channel:      typeof filters.channel     === "string" ? filters.channel     : null,
    distributors: Array.isArray(filters.distributors) ? filters.distributors : [],
    lines:        Array.isArray(filters.lines)         ? filters.lines         : [],
    regions:      Array.isArray(filters.regions)       ? filters.regions       : [],
    areas:        Array.isArray(filters.areas)         ? filters.areas         : [],
    products:     Array.isArray(filters.products)      ? filters.products      : [],
    families:     Array.isArray(filters.families)      ? filters.families      : [],
    clientCodes:  Array.isArray(filters.clientCodes)   ? filters.clientCodes   : [],
    canViewHeadOffice: canViewHeadOfficeLine(role),
  };

  let byCustomer: SosByCustomerRow[];
  let dimensions: AnalyticsDimensions;

  if (demo) {
    byCustomer = demoSosByCustomer();
    dimensions = demoAnalyticsDimensions();
  } else {
    [byCustomer, dimensions] = await Promise.all([
      loadSosByCustomer(sosFilters).catch(() => []),
      loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions()),
    ]);
  }

  const customerOptions = [...new Map(byCustomer.map((c) => [c.clientCode, c.clientCode])).keys()]
    .map((code) => ({ code, label: code }));

  return (
    <div className="space-y-5">
      {demo ? <AnalyticsDemoBanner /> : null}

      <AnalyticsFilterBar
        descriptors={SOS_FILTERS}
        values={filters}
        dimensions={dimensions}
        basePath="/admin/analytics/source-sales/by-customer"
        customers={customerOptions}
      />

      <AnalyticsSection title="Customer Presence" count={byCustomer.length}>
        {byCustomer.length === 0 ? (
          <AnalyticsEmptyState message="No customer presence data for the current filters." />
        ) : (
          <AnalyticsDataTable
            searchKeys={["clientCode", "regionName", "line"]}
            columns={[
              { key: "period",       label: "Period",        sortable: true },
              { key: "clientCode",   label: "Customer Code", sortable: true },
              { key: "line",         label: "Line",          sortable: true },
              { key: "regionName",   label: "Region",        sortable: true },
              { key: "activeBatches", label: "Active Batches", align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={byCustomer}
            exportTitle="SoS Customer Presence"
            exportSubtitle="Active customer presence by period and region"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export default async function SosByCustomerPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  await assertPermission(access, "sales", "read");

  const resolvedParams = await searchParams;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="w-1 h-12 bg-[#F97316] shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#F97316] mb-0.5">SoS</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">SoS — Customer Presence</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Active customers by period, region, and product line. Presence data — not invoice values.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={SOS_TABS} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ByCustomerContent searchParams={resolvedParams} role={access.role} />
      </Suspense>
    </div>
  );
}
