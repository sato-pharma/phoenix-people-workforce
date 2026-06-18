import { redirect } from "next/navigation";
import { Target } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { SalesMarketingIntelligenceDashboard } from "@/components/sales-marketing-intelligence/sales-marketing-intelligence-dashboard";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import type { SalesMarketingDashboardSnapshot } from "@/lib/sales-marketing-intelligence/types";
import {
  canAccessSalesMarketingIntelligence,
  getSalesMarketingDashboardSnapshot,
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

  let snapshot: SalesMarketingDashboardSnapshot | null = null;
  let loadError: unknown = null;
  try {
    snapshot = await getSalesMarketingDashboardSnapshot(access, filters);
  } catch (error) {
    loadError = error;
  }

  if (snapshot) {
    return <SalesMarketingIntelligenceDashboard filters={filters} snapshot={snapshot} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <AdminPageHero
        description="Corporate decision view for Marketing ROI, request spend, customer and pharmacy impact, and attribution trust."
        eyebrow="Marketing ROI"
        icon={<Target className="h-4 w-4" />}
        title="Marketing ROI & Customer Intelligence"
      />
      <AdminCallout tone="warning">
        <div className="space-y-1">
          <p className="font-bold">Dashboard data is not available.</p>
          <p>{dashboardLoadMessage(loadError)}</p>
        </div>
      </AdminCallout>
    </div>
  );
}
