import { redirect } from "next/navigation";

import { CeoCommandCenter } from "@/components/admin/ceo-command-center";
import { AppShell } from "@/components/layout/app-shell";
import { getAdminCommandCenterData, type AdminCommandCenterData } from "@/lib/admin/command-center";
import { getCeoBrief, type CeoBriefData } from "@/lib/ceo/brief";
import { computeCompanyHealth, type CompanyHealth } from "@/lib/ceo/health-score";
import { buildStrategicRiskRegister, type RiskRegister } from "@/lib/ceo/risk";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { formatHrIdForDisplay } from "@/lib/hr-id";

export const dynamic = "force-dynamic";

export default async function CeoCommandCenterPage() {
  const access = await resolveAccessContextFromPage();

  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  // Executive surface is reserved for the CEO (and Super Admin / system scope).
  // Server-side enforcement — sidebar visibility is UX only, never the boundary.
  //
  // GOVERNANCE NOTE (Phase 1): this surface intentionally uses the CEO's EXISTING
  // permission matrix unchanged and renders read-only, aggregate KPIs only. The CEO
  // governance lockdown (narrowing approve/admin grants) is deferred to Phase 2 by design.
  const isExecutive =
    access.role === "CEO" || access.role === "Super Admin" || access.scope === "system";
  if (!isExecutive) {
    redirect(resolveLandingPathForRole(access.role));
  }

  let data: AdminCommandCenterData | null = null;
  let loadError: string | null = null;
  try {
    data = await getAdminCommandCenterData(access);
  } catch (error) {
    console.error("Failed to load CEO Command Center:", error);
    loadError = error instanceof Error ? error.message : "Unknown error occurred";
  }

  let brief: CeoBriefData | null = null;
  try {
    brief = await getCeoBrief(access);
  } catch (error) {
    console.error("Failed to load CEO brief:", error);
  }

  const risk: RiskRegister = buildStrategicRiskRegister({
    alerts: brief?.alerts ?? null,
    alertsAvailable: brief !== null,
    payrollFlags: data?.overview.payroll.flags,
    pendingLeave: data?.overview.leave.pendingRequests,
    pendingOffers: data?.overview.recruitment.pendingOffers,
    dataUnavailable: data?.dataUnavailable,
    failureCount24h: data?.operations.failureCount24h,
    staleSources: data?.operations.staleSources,
  });

  const criticalRiskCount = risk.rows.filter((row) => row.severity === "critical").length;
  const health: CompanyHealth = computeCompanyHealth({
    employeeHealthRate: data?.health.employeeHealthRate ?? null,
    payrollFlags: data?.overview.payroll.flags ?? null,
    payrollEmployees: data?.overview.payroll.employees ?? null,
    salesAchievementPct: data ? data.overview.sales.achievementRate * 100 : null,
    criticalRiskCount,
    dataUnavailableCount: data?.dataUnavailable.length ?? null,
    salesLinkageRate: data?.health.salesLinkageRate ?? null,
  });

  const viewer = await resolveViewerIdentityFromPage(access);
  const executiveProfile = {
    fullName: viewer.displayName,
    roleLabel: viewer.roleLabel,
    hrId: formatHrIdForDisplay(access.hrId) ?? "",
  };

  return (
    <AppShell navigationMode="admin">
      <CeoCommandCenter
        brief={brief}
        data={data}
        generatedAtIso={new Date().toISOString()}
        health={health}
        loadError={loadError}
        risk={risk}
        viewer={executiveProfile}
      />
    </AppShell>
  );
}
