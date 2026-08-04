import { redirect } from "next/navigation";

import { MonthlyClosingWorkspace } from "@/components/sales/monthly-closing-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  loadMonthlyClosing,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import { loadMonthlySourceCoverage, type MonthlySourceCoverage } from "@/lib/sales/source-coverage";

export const dynamic = "force-dynamic";

export default async function MonthlyClosingPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }

  // The admin upload + publish workspace is reserved for the admin account (Super Admin /
  // system scope). Sales managers and product managers consume the published closing through
  // the employee-portal Monthly Closing tab instead. Server-side enforcement.
  if (access.role !== "Super Admin" && access.scope !== "system") {
    redirect(resolveLandingPathForRole(access.role));
  }

  let initialMatrix: MonthlyClosingMatrix | null = null;
  let initialCoverage: MonthlySourceCoverage | null = null;
  let initialError: string | null = null;

  try {
    await assertPermission(access, "sales", "import");
    initialMatrix = await loadMonthlyClosing();
    // Completeness ride-along; a coverage failure hides the banner, never the closing.
    initialCoverage = await loadMonthlySourceCoverage(initialMatrix.line, initialMatrix.period).catch(() => null);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Monthly Closing.";
  }

  return (
    <MonthlyClosingWorkspace
      canPublish
      initialCoverage={initialCoverage}
      initialError={initialError}
      initialMatrix={initialMatrix}
    />
  );
}
