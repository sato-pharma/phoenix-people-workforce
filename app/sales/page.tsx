import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/components/layout/app-shell";
import { SalesDashboard } from "@/components/sales/sales-dashboard";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSalesDashboard } from "@/lib/sales/service";

export const dynamic = "force-dynamic";

export default async function SalesPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }

  await assertPermission(accessContext, "sales", "read");

  return (
    <AppShell accessContext={accessContext} navigationMode="admin">
      <Suspense
        fallback={
          <AppRouteLoadingState
            title="Loading Sales"
            description="Preparing approved sales, targets, ownership, and transactions."
          />
        }
      >
        <SalesContent accessContext={accessContext} />
      </Suspense>
    </AppShell>
  );
}

async function SalesContent({ accessContext }: { accessContext: AccessContext }) {
  let initialData = null;
  let initialError: string | null = null;

  try {
    initialData = await getSalesDashboard({}, accessContext);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load sales dashboard.";
  }

  return (
    <SalesDashboard
      initialData={initialData}
      initialError={initialError}
    />
  );
}
