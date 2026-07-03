import { redirect } from "next/navigation";
import { Suspense } from "react";

import { SosDashboard } from "@/components/sales/sos-dashboard";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canExportSosDashboard, canViewRestrictedProducts } from "@/lib/sales/access-scope";
import { getSosDashboard, type SosDashboardData } from "@/lib/sales/sos-dashboard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function SourceOfSalesDashboardPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }

  await assertPermission(accessContext, "sales", "read");

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading Source of Sales Dashboard"
          description="Preparing approved sales, targets, channel mix, territories and trends."
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
    // Confidential products stay excluded on the initial load even for CEO/Super Admin —
    // omitting revealRestrictedProducts here is what makes the dashboard default-off.
    initialData = await getSosDashboard({}, accessContext, { includeMomComparison: true, includeYoY: true });
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Source of Sales dashboard.";
  }

  return (
    <SosDashboard
      initialData={initialData}
      initialError={initialError}
      canExport={canExportSosDashboard(accessContext.role)}
      canRevealRestricted={canViewRestrictedProducts(accessContext.role)}
    />
  );
}
