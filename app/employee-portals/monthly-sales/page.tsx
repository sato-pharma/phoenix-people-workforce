import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MonthlyClosingPortalView } from "@/components/sales/monthly-closing-portal-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import {
  loadPortalLiveMonthly,
  type PortalClosingResult,
} from "@/lib/sales/monthly-closing-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sales Intelligence section is Product / Group Product Managers only. The loader resolves the
// viewer's line from their HR_ID, scopes columns to their assigned products, and strips
// confidential products. Unlike /employee-portals/monthly-closing this view is LIVE — it is not
// gated behind the admin "publish" step, so PM/GPM always see current Source-of-Sales numbers.
const MONTHLY_PORTAL_ROLES = new Set(["Product Manager", "Group Product Manager", "Marketing Manager", "National Sales Manager", "District Manager", "Regional Manager", "Medical Rep", "SFE Manager", "CEO", "Super Admin"]);

export default async function PortalMonthlySalesPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!MONTHLY_PORTAL_ROLES.has(access.role) || !(await canAccess(access, "sales", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const { period } = await searchParams;

  let result: PortalClosingResult | null = null;
  try {
    result = await loadPortalLiveMonthly({ access, period });
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/monthly-sales", module: "monthly-sales", role: access.role, hrId: access.hrId },
      error,
    );
    result = null;
  }

  return (
    <EmployeePortalPageShell
      badge="Sales Operations"
      description="Your products' monthly sales from Source of Sales — by area and region, rolled up to national. Live, not gated by publishing."
      errorBoundaryTitle="Monthly Sales Closing unavailable"
      title="Monthly Sales Closing"
    >
      <MonthlyClosingPortalView
        awaitingPublish={false}
        availablePeriods={result?.availablePeriods ?? []}
        basePath="/employee-portals/monthly-sales"
        distributorsExpected={result?.distributorsExpected ?? null}
        distributorsUploaded={result?.distributorsUploaded ?? null}
        emptyMessage="No validated Source-of-Sales months are available for your products yet. Months appear here as soon as their sales are uploaded — no publishing step required."
        emptyTitle="No monthly sales yet"
        line={result?.line ?? null}
        matrix={result?.matrix ?? null}
        productScoped
        selectedPeriod={result?.selectedPeriod ?? null}
        trend={[]}
      />
    </EmployeePortalPageShell>
  );
}
