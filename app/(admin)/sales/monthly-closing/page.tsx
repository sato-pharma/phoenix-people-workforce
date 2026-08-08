import { redirect } from "next/navigation";

import { MonthlyClosingWorkspace } from "@/components/sales/monthly-closing-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";
import { loadMonthlyClosingWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import { loadMonthlySourceCoverage, type MonthlySourceCoverage } from "@/lib/sales/source-coverage";

export const dynamic = "force-dynamic";

export default async function MonthlyClosingPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }

  // The admin upload + publish workspace. Super Admin gets full read/write/publish. SFE Manager
  // gets view + download only (owner decision, 2026-08-05): he already holds sales:import for
  // Upload/Import Advanced and asked to see the matrix -- including pre-publish/draft state --
  // without ever being able to publish it himself. Everyone else still consumes the published
  // closing through the employee-portal Monthly Closing tab. Publish/unpublish stay hard-gated to
  // Super Admin independently in app/api/sales/monthly-closing/publish/route.ts's own
  // forbidNonAdmin check -- this check only controls page access and canPublish below, never the
  // publish action itself.
  const isSystemAdministratorViewer = access.role === "Super Admin" || access.scope === "system";
  if (!isSystemAdministratorViewer && access.role !== "SFE Manager") {
    redirect(resolveLandingPathForRole(access.role));
  }

  let initialMatrix: MonthlyClosingMatrix | null = null;
  let initialCoverage: MonthlySourceCoverage | null = null;
  let initialError: string | null = null;

  try {
    await assertPermission(access, "sales", "import");
    initialMatrix = await loadMonthlyClosingWithStoreSplit();
    // Completeness ride-along; a coverage failure hides the banner, never the closing.
    initialCoverage = await loadMonthlySourceCoverage(initialMatrix.line, initialMatrix.period).catch(() => null);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Monthly Closing.";
  }

  return (
    <MonthlyClosingWorkspace
      canPublish={isSystemAdministratorViewer}
      initialCoverage={initialCoverage}
      initialError={initialError}
      initialMatrix={initialMatrix}
    />
  );
}
