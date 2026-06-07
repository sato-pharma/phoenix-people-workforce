import { redirect } from "next/navigation";

import { SalesCommandDashboard } from "@/components/admin/sales-command-dashboard";
import { getAdminCommandCenterData, type AdminCommandCenterData } from "@/lib/admin/command-center";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listSalesPeriods, loadExecutiveReport, type ExecutiveReport } from "@/lib/sales/executive-report";

export const dynamic = "force-dynamic";

// Shift a YYYY-MM period back N months for the month-over-month (N=1) and year-over-year (N=12)
// comparison columns. Returns null for anything that is not a clean YYYY-MM string.
function shiftPeriod(period: string, monthsBack: number): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return null;
  let year = Number(match[1]);
  let month = Number(match[2]) - monthsBack;
  while (month <= 0) {
    month += 12;
    year -= 1;
  }
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

async function safeReport(period: string | null): Promise<{ data: ExecutiveReport | null; error: string | null }> {
  try {
    return { data: await loadExecutiveReport(period), error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : "Failed to load Source of Sales data." };
  }
}

export default async function SalesCommandPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  // The CEO lands here at login. Reserved for the CEO, Super Admin, and system scope.
  // Server-side enforcement — sidebar visibility is UX only, never the boundary.
  const isExecutive = access.role === "CEO" || access.role === "Super Admin" || access.scope === "system";
  if (!isExecutive) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const requested = typeof params.period === "string" ? params.period : undefined;

  const periods = await listSalesPeriods();
  const selected: string | null =
    requested === "all"
      ? null
      : requested && periods.includes(requested)
        ? requested
        : periods[0] ?? null;

  const priorPeriod = selected ? shiftPeriod(selected, 1) : null;
  const yoyPeriod = selected ? shiftPeriod(selected, 12) : null;
  const loadPrior = priorPeriod && periods.includes(priorPeriod) ? priorPeriod : null;
  const loadYoy = yoyPeriod && periods.includes(yoyPeriod) ? yoyPeriod : null;

  const emptyReport = { data: null as ExecutiveReport | null, error: null as string | null };
  const [reportResult, priorResult, yoyResult, stripData] = await Promise.all([
    safeReport(selected),
    loadPrior ? safeReport(loadPrior) : Promise.resolve(emptyReport),
    loadYoy ? safeReport(loadYoy) : Promise.resolve(emptyReport),
    getAdminCommandCenterData(access)
      .then((data) => ({ data: data as AdminCommandCenterData | null, error: null as string | null }))
      .catch((error) => ({
        data: null as AdminCommandCenterData | null,
        error: error instanceof Error ? error.message : "Company pulse unavailable.",
      })),
  ]);

  return (
    <SalesCommandDashboard
      generatedAtIso={new Date().toISOString()}
      loadError={reportResult.error}
      periods={periods}
      prior={priorResult.data}
      priorPeriod={loadPrior}
      report={reportResult.data}
      selected={selected}
      strip={stripData}
      yoy={yoyResult.data}
      yoyPeriod={loadYoy}
    />
  );
}
