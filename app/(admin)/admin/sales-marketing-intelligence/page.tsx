import { Suspense } from "react";
import { redirect } from "next/navigation";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { SalesMarketingIntelligenceDashboard } from "@/components/sales-marketing-intelligence/sales-marketing-intelligence-dashboard";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import type { AccessContext } from "@/lib/auth/permissions";
import type { SalesMarketingDashboardFilters, SalesMarketingDashboardSnapshot } from "@/lib/sales-marketing-intelligence/types";
import {
  canAccessSalesMarketingIntelligence,
  getSalesMarketingDashboard,
  parseSalesMarketingDashboardFilters,
} from "@/lib/sales-marketing-intelligence/service";

export const dynamic = "force-dynamic";

type SalesMarketingSearchParams = {
  attribution?: string | string[];
  customer?: string | string[];
  distributor?: string | string[];
  fromMonth?: string | string[];
  line?: string | string[];
  limit?: string | string[];
  product?: string | string[];
  region?: string | string[];
  roiStatus?: string | string[];
  toMonth?: string | string[];
};

function dashboardLoadMessage(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object"
      ? [
          "message" in error ? error.message : null,
          "details" in error ? error.details : null,
          "hint" in error ? error.hint : null,
          "code" in error ? error.code : null,
        ]
          .map((value) => String(value ?? "").trim())
          .filter(Boolean)
          .join(" ")
      : String(error ?? "");
  const normalized = message.toLowerCase();
  if (
    normalized.includes("phx_marketing_roi_customer_dashboard") ||
    normalized.includes("could not find the function") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return "Marketing ROI & Customer Intelligence schema is not applied to the connected database yet. Apply the dashboard migration to staging before smoke testing this page.";
  }
  if (normalized.includes("timed out") || normalized.includes("57014") || normalized.includes("statement timeout")) {
    return "The dashboard aggregate query timed out. The page did not load raw rows; review the SQL plan and indexes before widening the filters.";
  }
  return message || "Failed to load Marketing ROI & Customer Intelligence.";
}

// Inner async component — loads data after the page shell streams to the client.
async function SalesMarketingDashboardContent({
  access,
  filters,
}: {
  access: AccessContext;
  filters: SalesMarketingDashboardFilters;
}) {
  let snapshot: SalesMarketingDashboardSnapshot | null = null;
  let loadError: unknown = null;
  try {
    snapshot = await getSalesMarketingDashboard(access, filters);
  } catch (error) {
    loadError = error;
  }

  if (snapshot) {
    return (
      <SalesMarketingIntelligenceDashboard
        canRefreshRoi={access.role === "Super Admin" || access.role === "CEO"}
        filters={filters}
        snapshot={snapshot}
      />
    );
  }

  return (
    <AdminCallout tone="warning">
      <div className="space-y-1">
        <p className="font-bold">Dashboard data is not available.</p>
        <p>{dashboardLoadMessage(loadError)}</p>
      </div>
    </AdminCallout>
  );
}

export default async function SalesMarketingIntelligencePage({
  searchParams,
}: {
  searchParams: Promise<SalesMarketingSearchParams>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!canAccessSalesMarketingIntelligence(access)) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const filters = parseSalesMarketingDashboardFilters(await searchParams);

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          description="Loading Marketing ROI & Customer Intelligence data."
          title="Loading dashboard"
        />
      }
    >
      <SalesMarketingDashboardContent access={access} filters={filters} />
    </Suspense>
  );
}
