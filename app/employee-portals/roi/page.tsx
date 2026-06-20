import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { SalesMarketingIntelligenceDashboard } from "@/components/sales-marketing-intelligence/sales-marketing-intelligence-dashboard";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import type { SalesMarketingDashboardSnapshot } from "@/lib/sales-marketing-intelligence/types";
import {
  canAccessSalesMarketingIntelligence,
  getSalesMarketingDashboardSnapshot,
  parseSalesMarketingDashboardFilters,
} from "@/lib/sales-marketing-intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sales Intelligence section is Product / Group Product Managers only. Line scope is
// applied inside getSalesMarketingDashboardSnapshot (resolveDashboardLineScope); the
// service also strips confidential products for non-CEO/Super-Admin viewers.
const ROI_PORTAL_ROLES = new Set(["Product Manager", "Group Product Manager"]);

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

  let snapshot: SalesMarketingDashboardSnapshot | null = null;
  let loadError: string | null = null;
  try {
    snapshot = await getSalesMarketingDashboardSnapshot(access, filters);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load ROI intelligence.";
  }

  return (
    <EmployeePortalPageShell
      badge="Sales Intelligence"
      description="Your line's marketing ROI — spend, required vs actual return, coverage gaps, and customer impact."
      errorBoundaryTitle="ROI Intelligence unavailable"
      title="ROI Intelligence"
    >
      {snapshot ? (
        <SalesMarketingIntelligenceDashboard
          basePath="/employee-portals/roi"
          chrome="portal"
          filters={filters}
          snapshot={snapshot}
        />
      ) : (
        <EmployeePortalEmptyState
          message={loadError ?? "No marketing ROI data is available for your line yet."}
          title="ROI data unavailable"
        />
      )}
    </EmployeePortalPageShell>
  );
}
