import { redirect } from "next/navigation";

import { MedicalRepOverviewPage } from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import {
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
  if (access.role === "Training Manager") {
    redirect("/employee-portals/training-manager");
  }
  await assertPermission(access, "employee_profile", "read");

  let data = null;
  try {
    data = await getMedicalRepPortalData(access, {
      teamComparisonPeriod,
    });
  } catch (err) {
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

  return (
    <EmployeePortalPageShell
      badge="Employee Portal"
      description="Performance, structure, and team comparison in one command surface."
      title="Dashboard Overview"
    >
      <MedicalRepOverviewPage data={data} />
    </EmployeePortalPageShell>
  );
}
