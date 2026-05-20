import { redirect } from "next/navigation";

import { EmployeePortalSidebar, EmployeePortalTopNav } from "@/components/employee-portal/employee-portal-layout";
import { IdentityCard } from "@/components/employee-portal/identity-card";
import { MobileOutstationWizard } from "@/components/outstation/mobile-outstation-wizard";
import { Card } from "@/components/ui/card";
import { PageTransition } from "@/components/ui/page-transition";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getDsmTeamPerformance, getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { getOutstationEmployeeContext } from "@/lib/outstation/service";

function buildResidenceSummary(residence: {
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
} | null) {
  if (!residence) return "Not configured";

  const parts = [residence.residenceAddress, residence.residenceCity, residence.residenceArea]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(" - ") : "Not configured";
}

export default async function EmployeeOutstationNewPage() {
  const access = await resolveAccessContextFromPage();

  const navigationMode = resolveNavigationMode(access);
  if (navigationMode !== "employee-portal") {
    redirect("/overview");
  }

  await assertPermission(access, "outstation", "create");

  const [portalDataResult, outstationContextResult, teamPerformanceResult] = await Promise.allSettled([
    getEmployeePortalShellData(access),
    getOutstationEmployeeContext(access),
    getDsmTeamPerformance(access),
  ]);

  if (portalDataResult.status === "rejected") {
    return (
      <div className="min-h-screen bg-[#f7f8fb] p-4">
        <div className="mx-auto w-full max-w-[1200px]">
          <Card className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
            <p className="text-lg font-semibold text-slate-900">Portal Unavailable</p>
            <p className="mt-2 text-sm text-slate-600">
              Unable to load your employee profile. Please contact HR to activate portal access.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  const portalData = portalDataResult.value;
  const outstationContext = outstationContextResult.status === "fulfilled" ? outstationContextResult.value : null;
  const visibility = resolveEmployeePortalNavVisibility(portalData.employee.roleLabel);

  const employeeName = outstationContext?.employeeName ?? portalData.employee.fullName;
  const employeeRole = outstationContext?.employeeRole ?? portalData.employee.roleLabel;
  const residenceSummary = buildResidenceSummary(outstationContext?.residence ?? null);
  const hasResidenceCoordinates = outstationContext?.residence
    ? outstationContext.residence.residenceLatitude !== null && outstationContext.residence.residenceLongitude !== null
    : false;
  const dsmTeamPerformance =
    teamPerformanceResult && teamPerformanceResult.status === "fulfilled"
      ? teamPerformanceResult.value
      : null;
  const medicalTripOptions =
    dsmTeamPerformance?.members.map((member) => ({
      hrId: member.hrId,
      name: member.name,
    })) ?? [];

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f6f7fb]">
      <EmployeePortalTopNav data={portalData} visibility={visibility} />

      <div className="mx-auto flex w-full max-w-[1600px] gap-6 px-4 py-6 lg:gap-8 lg:px-8 lg:py-8">
        <EmployeePortalSidebar visibility={visibility} />

        <main className="min-w-0 flex-1 space-y-6 lg:space-y-8">
          <IdentityCard data={portalData} />
          <PageTransition>
            <MobileOutstationWizard
              employeeHrId={access.hrId ?? portalData.employee.hrId}
              employeeName={employeeName}
              employeeRole={employeeRole}
              hasResidenceCoordinates={hasResidenceCoordinates}
              medicalTripOptions={medicalTripOptions}
              residenceSummary={residenceSummary}
            />
          </PageTransition>
        </main>
      </div>
    </div>
  );
}
