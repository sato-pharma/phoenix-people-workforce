import { Suspense } from "react";

import { AnalyticsDataTable } from "@/components/analytics/analytics-data-table";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { AnalyticsDemoBanner } from "@/components/analytics/analytics-demo-banner";
import { AnalyticsModuleNav } from "@/components/analytics/analytics-module-nav";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, type PhoenixRole } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { AnalyticsDualShell } from "@/components/analytics/analytics-dual-shell";
import { canViewHeadOfficeLine } from "@/lib/sales/access-scope";
import {
  loadAnalyticsDimensions,
  loadSosByCustomer,
  type AnalyticsDimensions,
  type SosByCustomerRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { SOS_CUSTOMER_FILTERS } from "@/lib/analytics/sales-filter-config";
import { resolveAnalyticsViewerScope, scopeAnalyticsFilters, scopeAnalyticsDimensions, computeAnalyticsFilterVisibility, type AnalyticsViewerScope } from "@/lib/analytics/scope";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoSosByCustomer } from "@/lib/analytics/demo-fixtures";
import { SOS_TABS } from "@/lib/analytics/module-nav-config";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function ByCustomerContent({
  searchParams,
  role,
  scope,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  role: PhoenixRole;
  scope: AnalyticsViewerScope;
}) {
  const demo = isAnalyticsDemoMode(searchParams);
  const filters = parseAnalyticsFilters(searchParams, SOS_CUSTOMER_FILTERS);

  // analytics_sos_by_customer only filters on period / line / region / customer — build exactly
  // those (see SOS_CUSTOMER_FILTERS). Other SoS dimensions are not accepted by that RPC.
  const sosFilters = {
    period:      typeof filters.period      === "string" ? filters.period      : null,
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
    dimensions = await loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions());
  } else {
    [byCustomer, dimensions] = await Promise.all([
      loadSosByCustomer(scoped.filters).catch(() => []),
      loadAnalyticsDimensions(role).catch(() => demoAnalyticsDimensions()),
    ]);
  }

  // One option per customer, labelled by NAME (falls back to the code). First occurrence wins.
  const customerOptions = [
    ...new Map(byCustomer.map((c) => [c.clientCode, c.customerName || c.clientCode])).entries(),
  ].map(([code, label]) => ({ code, label }));

  return (
    <div className="space-y-5">
      {demo ? <AnalyticsDemoBanner /> : null}

      <AnalyticsFilterBar
        descriptors={SOS_CUSTOMER_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath="/admin/analytics/source-sales/by-customer"
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
              { key: "clientCode",   label: "Code",     sortable: true },
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

export default async function SosByCustomerPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "sales", "read");
  const scope = await resolveAnalyticsViewerScope(access);

  const resolvedParams = await searchParams;

  return (
    <AnalyticsDualShell access={access}>
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
          <ByCustomerContent searchParams={resolvedParams} role={access.role} scope={scope} />
        </Suspense>
      </div>
    </AnalyticsDualShell>
  );
}
