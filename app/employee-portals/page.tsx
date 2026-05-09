import { redirect } from "next/navigation";

import { MedicalRepOverviewPage, EmptyStateCard } from "@/components/employee-portal/employee-portal-dashboard";
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
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-lg font-semibold text-slate-900">Portal Unavailable</p>
        <p className="mt-2 text-sm text-slate-600">Your command center is temporarily unavailable. Please try again in a moment.</p>
      </div>
    );
  }

  return <MedicalRepOverviewPage data={data} />;
}
