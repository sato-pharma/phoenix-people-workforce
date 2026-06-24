import { redirect } from "next/navigation";
import { Suspense } from "react";

import { SosDashboard } from "@/components/sales/sos-dashboard";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSosDashboard, type SosDashboardData } from "@/lib/sales/sos-dashboard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function MClosingDashboardPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/monthly-closing");
  }

  await assertPermission(accessContext, "sales", "read");

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading M.Closing Dashboard"
          description="Preparing monthly closing data from the Sales Queue pipeline."
        />
      }
    >
      <MClosingContent accessContext={accessContext} />
    </Suspense>
  );
}

async function MClosingContent({ accessContext }: { accessContext: AccessContext }) {
  let initialData: SosDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getSosDashboard({}, accessContext);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load M.Closing dashboard.";
  }

  return <SosDashboard initialData={initialData} initialError={initialError} />;
}
