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
import { canViewHeadOfficeLine, canViewRestrictedProducts } from "@/lib/sales/access-scope";
import {
  loadAnalyticsDimensions,
  loadSosByProduct,
  type AnalyticsDimensions,
  type SosByProductRow,
} from "@/lib/analytics/service";
import { parseAnalyticsFilters } from "@/lib/analytics/filter-registry";
import { SOS_FILTERS } from "@/lib/analytics/sales-filter-config";
import { scopeAnalyticsFilters, scopeAnalyticsDimensions, computeAnalyticsFilterVisibility, type AnalyticsViewerScope } from "@/lib/analytics/scope";
import { isAnalyticsDemoMode } from "@/lib/analytics/demo-mode";
import { demoAnalyticsDimensions, demoSosByProduct } from "@/lib/analytics/demo-fixtures";
import { SOS_TABS } from "@/lib/analytics/module-nav-config";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

// Shared Source-of-Sales "By Product" dashboard. Rendered at /admin/analytics and
// /employee-portals/sales-analytics via `mountRoot` (see source-sales-dashboard.tsx).

async function ByProductContent({
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
  const filters = parseAnalyticsFilters(searchParams, SOS_FILTERS);

  const sosFilters = {
    period:       Array.isArray(filters.period)      ? filters.period      : [],
    periodFrom:   typeof filters.periodFrom  === "string" ? filters.periodFrom  : null,
    periodTo:     typeof filters.periodTo    === "string" ? filters.periodTo    : null,
    channel:      Array.isArray(filters.channel)     ? filters.channel     : [],
    distributors: Array.isArray(filters.distributors) ? filters.distributors : [],
    lines:        Array.isArray(filters.lines)         ? filters.lines         : [],
    regions:      Array.isArray(filters.regions)       ? filters.regions       : [],
    areas:        Array.isArray(filters.areas)         ? filters.areas         : [],
    products:     Array.isArray(filters.products)      ? filters.products      : [],
    families:     Array.isArray(filters.families)      ? filters.families      : [],
    clientCodes:  Array.isArray(filters.clientCodes)   ? filters.clientCodes   : [],
    canViewHeadOffice: canViewHeadOfficeLine(role),
    canViewRestrictedProducts: canViewRestrictedProducts(role),
  };
  const scoped = scopeAnalyticsFilters(sosFilters, scope);

  let byProduct: SosByProductRow[];
  let dimensions: AnalyticsDimensions;

  if (demo) {
    byProduct = demoSosByProduct();
    dimensions = demoAnalyticsDimensions();
  } else if (scoped.empty) {
    byProduct = [];
    dimensions = await loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions()));
  } else {
    [byProduct, dimensions] = await Promise.all([
      loadSosByProduct(scoped.filters).catch(trackFailure(analyticsFailures, "Sales by product", [])),
      loadAnalyticsDimensions(role).catch(trackFailure(analyticsFailures, "Filter options", emptyAnalyticsDimensions())),
    ]);
  }

  const prodMap = new Map<string, { productName: string; family: string; line: string; units: number; value: number }>();
  for (const r of byProduct) {
    const cur = prodMap.get(r.productCode) ?? { productName: r.productName, family: r.family, line: r.line, units: 0, value: 0 };
    prodMap.set(r.productCode, { ...cur, units: cur.units + r.units, value: cur.value + r.value });
  }
  const productTotals = [...prodMap.values()].sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-5">
      {demo ? <AnalyticsDemoBanner /> : null}
      {analyticsFailures.length > 0 ? <AnalyticsErrorState what={analyticsFailures.join(", ")} /> : null}

      <AnalyticsFilterBar
        descriptors={SOS_FILTERS}
        values={filters}
        dimensions={scopeAnalyticsDimensions(dimensions, scope)}
        visibility={computeAnalyticsFilterVisibility(scope)}
        basePath={`${mountRoot}/source-sales/by-product`}
      />

      <AnalyticsSection title="Product Mix (Aggregated)" count={productTotals.length}>
        {productTotals.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["productName", "family", "line"]}
            columns={[
              { key: "line",        label: "Line",    sortable: true },
              { key: "family",      label: "Family",  sortable: true },
              { key: "productName", label: "Product", sortable: true },
              { key: "units",       label: "Units",   align: "right", sortable: true, formatKind: "number" },
              { key: "value",       label: "Value (EGP)", align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={productTotals}
            totals={{ value: productTotals.reduce((s, r) => s + r.value, 0) }}
            exportTitle="SoS Product Mix"
            exportSubtitle="Source of Sales aggregated by product"
          />
        )}
      </AnalyticsSection>

      <AnalyticsSection title="Period × Product Detail" count={byProduct.length}>
        {byProduct.length === 0 ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsDataTable
            searchKeys={["productName", "family", "line"]}
            columns={[
              { key: "period",      label: "Period",   sortable: true },
              { key: "line",        label: "Line",     sortable: true },
              { key: "family",      label: "Family",   sortable: true },
              { key: "productName", label: "Product",  sortable: true },
              { key: "channel",     label: "Channel" },
              { key: "units",       label: "Units",    align: "right", sortable: true, formatKind: "number" },
              { key: "value",       label: "Value",    align: "right", sortable: true, formatKind: "number" },
            ]}
            rows={byProduct}
            exportTitle="SoS By Product Detail"
            exportSubtitle="Period-level SoS by product"
          />
        )}
      </AnalyticsSection>
    </div>
  );
}

export function SourceSalesByProductDashboard({
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
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>SoS</p>
          <h1 className={pageHeaderTitleClassName}>SoS — By Product</h1>
          <p className={pageHeaderDescriptionClassName}>
            Product mix analysis. Aggregated totals and period-level detail across all products.
          </p>
        </div>
      </div>

      <AnalyticsModuleNav tabs={SOS_TABS} mountRoot={mountRoot} />

      <Suspense fallback={<AppRouteLoadingState />}>
        <ByProductContent searchParams={searchParams} role={role} scope={scope} mountRoot={mountRoot} />
      </Suspense>
    </div>
  );
}
