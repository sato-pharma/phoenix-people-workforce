import { redirect } from "next/navigation";
import { Suspense } from "react";

import { MonthlySalesDashboard } from "@/components/sales/monthly-sales-dashboard";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSalesDashboard } from "@/lib/sales/service";
import type { SalesDashboardData } from "@/lib/sales/types";

export const dynamic = "force-dynamic";

export default async function SalesPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }

  await assertPermission(accessContext, "sales", "read");

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading Sales"
          description="Preparing approved sales, targets, ownership, channels, and trends."
        />
      }
    >
      <SalesContent accessContext={accessContext} />
    </Suspense>
  );
}

async function SalesContent({ accessContext }: { accessContext: AccessContext }) {
  let initialData: SalesDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getSalesDashboard({}, accessContext);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load sales dashboard.";
  }

  return <MonthlySalesDashboard initialData={initialData} initialError={initialError} />;
}
