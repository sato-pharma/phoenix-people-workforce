import { Suspense } from "react";

import { emptyAnalyticsDimensions, trackFailure } from "@/lib/analytics/load-result";
import { AnalyticsErrorState } from "@/components/analytics/analytics-error-state";
import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { AnalyticsDemoBanner } from "@/components/analytics/analytics-demo-banner";
import { AnalyticsModuleNav } from "@/components/analytics/analytics-module-nav";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { type PhoenixRole } from "@/lib/auth/permissions";
import { canViewHeadOfficeLine } from "@/lib/sales/access-scope";
import {
  loadAnalyticsDimensions,
  loadSosByCustomer,
  type AnalyticsDimensions,
  type SosByCustomerRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { SOS_CUSTOMER_FILTERS } from "@/lib/analytics/sales-filter-config";
import { scopeAnalyticsFilters, scopeAnalyticsDimensions, computeAnalyticsFilterVisibility, type AnalyticsViewerScope } from "@/lib/analytics/scope";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoSosByCustomer } from "@/lib/analytics/demo-fixtures";
import { SOS_TABS } from "@/lib/analytics/module-nav-config";

// Shared Source-of-Sales "Customer Presence" dashboard. Rendered at /admin/analytics and
// /employee-portals/sales-analytics via `mountRoot` (see source-sales-dashboard.tsx).

async function ByCustomerContent({
  searchParams,
  role,
  scope,
  mountRoot,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
  scope: AnalyticsViewerScope;
  mountRoot: string;
}) {
  const demo = isAnalyticsDemoMode(searchParams);
  // Loads that fail are recorded here, never silently rendered as a zero.
  const analyticsFailures: string[] = [];
  const filters = parseAnalyticsFilters(searchParams, SOS_CUSTOMER_FILTERS);

  // analytics_sos_by_customer only filters on period / line / region / customer — build exactly
  // those (see SOS_CUSTOMER_FILTERS). Other SoS dimensions are not accepted by that RPC.
  const sosFilters = {
    period:      Array.isArray(filters.period)      ? filters.period      : [],
    periodFrom:  typeof filters.periodFrom  === "string" ? filters.periodFrom  : null,
    periodTo:    typeof filters.periodTo    === "string" ? filters.periodTo    : null,
    lines:       Array.isArray(filters.lines)       ? filters.lines       : [],
    regions:     Array.isArray(filters.regions)     ? filters.regions     : [],
    clientCodes: Array.isArray(filters.clientCodes) ? filters.clientCodes : [],
    canViewHeadOffice: canViewHeadOfficeLine(role),
  };
  const scoped = scopeAnalyticsFilters(sosFilters, scope);

  let byCustomer: SosByCustomerRow[];
  let dimensions: AnalyticsDimensions;

  if (demo) {
    byCustomer = demoSosByCustomer();
    dimensions = demoAnalyticsDimensions();
  } else if (scoped.empty) {
    byCustomer = [];
    dimensions = await loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions()));
  } else {
    [byCustomer, dimensions] = await Promise.all([
      loadSosByCustomer(scoped.filters).catch(trackFailure(analyticsFailures, "Sales by customer", [])),
      loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions())),
    ]);
  }

  // One option per customer, labelled by NAME (falls back to the code). First occurrence wins.
  const customerOptions = [
    ...new Map(byCustomer.map((c) => [c.clientCode, c.customerName || c.clientCode])).entries(),
  ].map(([code, label]) => ({ code, label }));

  return (
    <div className="space-y-5">
      {demo ? <AnalyticsDemoBanner /> : null}
      {analyticsFailures.length > 0 ? <AnalyticsErrorState what={analyticsFailures.join(", ")} /> : null}

      <AnalyticsFilterBar
        descriptors={SOS_CUSTOMER_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath={`${mountRoot}/source-sales/by-customer`}
        customers={customerOptions}
      />

      <AnalyticsSection title="Customer Presence" count={byCustomer.length}>
        {byCustomer.length === 0 ? (
          <AnalyticsEmptyState message="No customer presence data for the current filters." />
        ) : (
          <AnalyticsDataTable
            searchKeys={["customerName", "clientCode", "regionName", "line"]}
            columns={[
              { key: "period",       label: "Period",   sortable: true },
              { key: "customerName", label: "Customer", sortable: true },
              { key: "line",         label: "Line",     sortable: true },
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

export function SourceSalesByCustomerDashboard({
  searchParams,
  role,
  scope,
  mountRoot,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
  scope: AnalyticsViewerScope;
  mountRoot: string;
}) {
  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="w-1 h-12 bg-phx-accent shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-phx-accent mb-0.5">SoS</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">SoS — Customer Presence</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Active customers by period, region, and product line. Presence data — not invoice values.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={SOS_TABS} mountRoot={mountRoot} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ByCustomerContent searchParams={searchParams} role={role} scope={scope} mountRoot={mountRoot} />
      </Suspense>
    </div>
  );
}
