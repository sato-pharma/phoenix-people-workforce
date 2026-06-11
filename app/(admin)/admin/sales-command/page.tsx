import { redirect } from "next/navigation";

import { SalesCommandDashboard } from "@/components/admin/sales-command-dashboard";
import { getAdminCommandCenterData, type AdminCommandCenterData } from "@/lib/admin/command-center";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listSalesPeriods, loadExecutiveReport, type ExecutiveReport } from "@/lib/sales/executive-report";
import { shiftPeriod } from "@/lib/sales/periods";

export const dynamic = "force-dynamic";
// The Source-of-Sales aggregates scan the full month of fact rows server-side and can take
// well over the platform's default function limit. Raise the ceiling so the page renders the
// real report instead of being killed mid-load. (Vercel clamps to the plan's max.)
export const maxDuration = 60;

// A Supabase PostgrestError is a plain object (not an Error subclass), so `instanceof Error`
// silently swallows its `message`/`details`/`hint`/`code`. Extract a human string from whatever
// shape was thrown, and log the full object server-side so the real cause is never lost.
function describeLoadError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint, record.code]
      .filter((part): part is string => typeof part === "string" && part.length > 0);
    if (parts.length > 0) return parts.join(" — ");
  }
  return "Failed to load Source of Sales data.";
}

async function safeReport(
  period: string | null,
  mode: "full" | "comparison" = "full",
): Promise<{ data: ExecutiveReport | null; error: string | null }> {
  try {
    return { data: await loadExecutiveReport(period, { mode }), error: null };
  } catch (error) {
    console.error(`[sales-command] loadExecutiveReport failed for period=${period ?? "all"} (${mode}):`, error);
    return { data: null, error: describeLoadError(error) };
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
    safeReport(selected, "full"),
    // Baselines only feed MoM/YoY delta columns — load them lightly (distributor×product only).
    loadPrior ? safeReport(loadPrior, "comparison") : Promise.resolve(emptyReport),
    loadYoy ? safeReport(loadYoy, "comparison") : Promise.resolve(emptyReport),
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
