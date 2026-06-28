import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MonthlyClosingPortalView } from "@/components/sales/monthly-closing-portal-view";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import {
  canAccessPortalClosing,
  loadPortalMonthlyClosing,
  loadPortalClosingTrend,
} from "@/lib/sales/monthly-closing-portal";

export const dynamic = "force-dynamic";

const PRODUCT_SCOPED_ROLES = new Set(["Product Manager", "Group Product Manager"]);

export default async function EmployeePortalMonthlyClosingPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const access = await resolveAccessContextFromPage();

  // Role-gated (not shell-gated): sales managers + product managers only.
  if (!canAccessPortalClosing(access)) {
    redirect("/employee-portals");
  }
  await assertPermission(access, "sales", "read");

  const { period } = await searchParams;

  let result = null;
  let trend = [] as Awaited<ReturnType<typeof loadPortalClosingTrend>>;
  try {
    [result, trend] = await Promise.all([
      loadPortalMonthlyClosing({ access, period }),
      loadPortalClosingTrend({ access, maxMonths: 6 }),
    ]);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/monthly-closing", module: "monthly-closing", role: access.role, hrId: access.hrId },
      error,
    );
    result = null;
  }

  return (
    <EmployeePortalPageShell
      badge="Monthly Closing"
      description="Your line's published monthly sales closing — by area and region, with a month-over-month trend."
      errorBoundaryTitle="Monthly Closing unavailable"
      title="Monthly Closing"
    >
      <MonthlyClosingPortalView
        awaitingPublish={result?.awaitingPublish ?? false}
        availablePeriods={result?.availablePeriods ?? []}
        line={result?.line ?? null}
        matrix={result?.matrix ?? null}
        productScoped={PRODUCT_SCOPED_ROLES.has(access.role)}
        selectedPeriod={result?.selectedPeriod ?? null}
        trend={trend}
      />
    </EmployeePortalPageShell>
  );
}
