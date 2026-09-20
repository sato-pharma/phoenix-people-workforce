import { redirect } from "next/navigation";

import { WeeklyUploadWorkspace } from "@/components/sales/weekly/weekly-upload-workspace";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { scopeWeeklyBatchesForViewer } from "@/lib/sales/weekly/batch-list-scope";
import { listWeeklyBatches, listWeeklyDistributors } from "@/lib/sales/weekly/service";
import type { WeeklyBatch, WeeklyDistributorOption } from "@/lib/sales/weekly/types";

export const dynamic = "force-dynamic";

export default async function WeeklySalesUploadPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  // Upload is gated on weekly_sales:import; a read-only viewer is sent to the dashboard instead of a
  // bare "Forbidden" shell (mirrors the monthly import page convention).
  if (!(await canAccess(access, "weekly_sales", "import"))) redirect("/sales/weekly/dashboard");

  let distributors: WeeklyDistributorOption[] = [];
  let initialBatches: WeeklyBatch[] = [];
  let initialError: string | null = null;
  try {
    // The batches go into the page's own props, so they are cut to the viewer's weekly access scope
    // here as well as in the API route (batch-list-scope.ts); a scope that cannot be read leaves the
    // list empty and shows the error rather than the uncut list.
    const scope = await resolveWeeklyAccessScope(access);
    const [loadedDistributors, loadedBatches] = await Promise.all([listWeeklyDistributors(), listWeeklyBatches()]);
    distributors = loadedDistributors;
    initialBatches = scopeWeeklyBatchesForViewer(loadedBatches, scope);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load weekly sales.";
  }

  return (
    <WeeklyUploadWorkspace distributors={distributors} initialBatches={initialBatches} initialError={initialError} />
  );
}
