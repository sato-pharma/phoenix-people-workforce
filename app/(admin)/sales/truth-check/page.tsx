import { redirect } from "next/navigation";

import { SalesTruthCheckReport } from "@/components/sales/sales-truth-check-report";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { listMonthlyClosingPeriods } from "@/lib/sales/monthly-distributor-import";
import { loadSalesTruthReport } from "@/lib/sales/sales-truth-report";

export const dynamic = "force-dynamic";
// Three closings plus a whole month of achievement rows. Slower than a normal page on purpose.
export const maxDuration = 120;

export default async function SalesTruthCheckPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const accessContext = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  // Whole-company per-area sales for every line — the same gate as the sibling closing tools.
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }
  await assertPermission(accessContext, "sales", "read");

  const requested = (await searchParams).period;
  const [report, periods] = await Promise.all([
    loadSalesTruthReport(requested && /^\d{4}-\d{2}$/.test(requested) ? requested : null),
    listMonthlyClosingPeriods(),
  ]);

  return <SalesTruthCheckReport periods={periods} report={report} />;
}
