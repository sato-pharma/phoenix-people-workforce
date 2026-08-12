import { redirect } from "next/navigation";

import { MonthlyClosingWorkspace } from "@/components/sales/monthly-closing-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import { loadMonthlySourceCoverage, type MonthlySourceCoverage } from "@/lib/sales/source-coverage";

export const dynamic = "force-dynamic";

export default async function MonthlyClosingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
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

  // Deep-linked from the closing-published email (see app/api/sales/monthly-closing/go/route.ts):
  // ?line=&period= pre-select which month opens, instead of always the default (latest) one. Absent
  // for a normal visit, which keeps today's default-to-latest behavior unchanged.
  const params = await searchParams;
  const requestedLine = typeof params.line === "string" ? params.line : Array.isArray(params.line) ? params.line[0] : null;
  const requestedPeriod = typeof params.period === "string" ? params.period : Array.isArray(params.period) ? params.period[0] : null;

  let initialMatrix: MonthlyClosingMatrix | null = null;
  // The Office-only grid behind every "of which Office" column. Null = could not be read.
  let initialOffice: MonthlyClosingMatrix | null = null;
  let initialCoverage: MonthlySourceCoverage | null = null;
  let initialError: string | null = null;

  try {
    await assertPermission(access, "sales", "import");
    const parts = await loadMonthlyClosingPartsWithStoreSplit({ line: requestedLine, period: requestedPeriod });
    initialMatrix = parts.combined;
    initialOffice = parts.office;
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
      initialOffice={initialOffice}
    />
  );
}
