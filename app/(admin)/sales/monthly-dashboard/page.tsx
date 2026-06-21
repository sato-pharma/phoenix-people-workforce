import { redirect } from "next/navigation";
import { Suspense } from "react";

import { SosDashboard } from "@/components/sales/sos-dashboard";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSosDashboard, type SosDashboardData } from "@/lib/sales/sos-dashboard";

export const dynamic = "force-dynamic";
// Safety net: the Source-of-Sales aggregation can take a few seconds on large months; give the
// server render headroom above the platform default so it never gets cut off mid-query.
export const maxDuration = 60;

export default async function SourceOfSalesDashboardPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/monthly-sales");
  }

  await assertPermission(accessContext, "sales", "read");

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading Source of Sales"
          description="Aggregating distributor invoices by channel, region, product, customer, and trend."
        />
      }
    >
      <SosDashboardContent accessContext={accessContext} />
    </Suspense>
  );
}

async function SosDashboardContent({ accessContext }: { accessContext: AccessContext }) {
  let initialData: SosDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getSosDashboard({}, accessContext);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load source-of-sales dashboard.";
  }

  return <SosDashboard initialData={initialData} initialError={initialError} />;
}
