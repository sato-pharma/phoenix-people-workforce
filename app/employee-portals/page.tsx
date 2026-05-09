import { redirect } from "next/navigation";

import { MedicalRepOverviewPage } from "@/components/employee-portal/employee-portal-dashboard";
import {
  EmployeePortalActionBar,
  EmployeePortalActionLink,
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";

export default async function EmployeePortalsHomePage({
  searchParams,
}: {
  searchParams: Promise<{ teamPeriod?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams;
  const access = await resolveAccessContextFromPage();
  const mode = resolveNavigationMode(access);
  const rawTeamPeriod = Array.isArray(resolvedSearchParams?.teamPeriod)
    ? resolvedSearchParams.teamPeriod[0]
    : resolvedSearchParams?.teamPeriod;
  const normalizedTeamPeriod = String(rawTeamPeriod ?? "").trim().toLowerCase();
  const teamComparisonPeriod = /^\d{4}-\d{2}$/.test(normalizedTeamPeriod) ? normalizedTeamPeriod : null;

  if (mode !== "employee-portal") {
    redirect("/overview");
  }
  await assertPermission(access, "employee_profile", "read");

  let data = null;
  try {
    data = await getMedicalRepPortalData(access, {
      teamComparisonPeriod,
    });
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Your command center is temporarily unavailable. Please try again in a moment."
        title="Portal Unavailable"
      />
    );
  }

  const formattedTeamPeriod = teamComparisonPeriod
    ? new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(
      new Date(`${teamComparisonPeriod}-01T00:00:00.000Z`),
    )
    : "Current period";

  return (
    <EmployeePortalPageShell
      badge="Employee Portal"
      description="Performance, payroll, and team comparison in one command surface."
      title="Dashboard Overview"
    >
      <EmployeePortalActionBar
        actions={
          <>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
              Team View: {formattedTeamPeriod}
            </span>
            <EmployeePortalActionLink href="/employee-portals/sales" label="Open Sales Workspace" />
            <EmployeePortalActionLink href="/employee-portals/payroll" label="Open Payroll Center" />
          </>
        }
      />
      <MedicalRepOverviewPage data={data} />
    </EmployeePortalPageShell>
  );
}
