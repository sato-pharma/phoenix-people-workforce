import { Suspense } from "react";
import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";
import { SalesMarketingIntelligenceDashboard } from "@/components/sales-marketing-intelligence/sales-marketing-intelligence-dashboard";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import type { AccessContext } from "@/lib/auth/permissions";
import type { SalesMarketingDashboardFilters, SalesMarketingDashboardSnapshot } from "@/lib/sales-marketing-intelligence/types";
import {
  canAccessSalesMarketingIntelligence,
  getSalesMarketingDashboard,
  parseSalesMarketingDashboardFilters,
} from "@/lib/sales-marketing-intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sales Intelligence section is Product / Group Product Managers, Marketing Manager,
// and National Sales Manager. Line scope is applied inside getSalesMarketingDashboard
// (resolveDashboardLineScope) — NSM's business scope is LINE (see getSalesScope), so
// they only ever see their own line's ROI/customer data; the service also strips
// confidential products for non-CEO/Super-Admin viewers.
const ROI_PORTAL_ROLES = new Set(["Product Manager", "Group Product Manager", "Marketing Manager", "National Sales Manager"]);

// Inner async component — loads data after the portal shell streams to the client.
async function RoiDashboardContent({
  access,
  filters,
}: {
  access: AccessContext;
  filters: SalesMarketingDashboardFilters;
}) {
  let snapshot: SalesMarketingDashboardSnapshot | null = null;
  let loadError: string | null = null;
  try {
    snapshot = await getSalesMarketingDashboard(access, filters);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load ROI intelligence.";
  }

  if (snapshot) {
    return (
      <SalesMarketingIntelligenceDashboard
        basePath="/employee-portals/roi"
        chrome="portal"
        filters={filters}
        hideLineRoiReport={access.role === "National Sales Manager"}
        snapshot={snapshot}
      />
    );
  }

  return (
    <EmployeePortalEmptyState
      message={loadError ?? "No marketing ROI data is available for your line yet."}
      title="ROI data unavailable"
    />
  );
}

export default async function PortalRoiIntelligencePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!ROI_PORTAL_ROLES.has(access.role) || !canAccessSalesMarketingIntelligence(access)) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const filters = parseSalesMarketingDashboardFilters(await searchParams);

  return (
    <EmployeePortalPageShell
      badge="Sales Intelligence"
      description="Your line's marketing ROI — spend, required vs actual return, coverage gaps, and customer impact."
      errorBoundaryTitle="ROI Intelligence unavailable"
      title="ROI Intelligence"
    >
      <Suspense fallback={<DashboardSkeleton kpiCount={4} chartCount={2} />}>
        <RoiDashboardContent access={access} filters={filters} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}
