import { redirect } from "next/navigation";

import { MobileOutstationWizard } from "@/components/outstation/mobile-outstation-wizard";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { getDsmTeamPerformance, getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { getOutstationEmployeeContext } from "@/lib/outstation/service";

// NOTE: dir="auto", print stylesheet, prefers-reduced-motion, and a
// page-level WorkspaceErrorBoundary are now provided automatically by
// EmployeePortalPageShell - no need to wire them per-page.

function buildResidenceSummary(residence: {
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
} | null) {
  if (!residence) return "Not configured";

  const parts = [residence.residenceAddress, residence.residenceArea, residence.residenceCity]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(" - ") : "Not configured";
}

function buildResidenceShortSummary(residence: {
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
} | null) {
  if (!residence) return "Not configured";

  const parts = [residence.residenceArea, residence.residenceCity]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : buildResidenceSummary(residence);
}

export default async function EmployeePortalSubmitExpensePage() {
  const access = await resolveAccessContextFromPage();

  const navigationMode = resolveNavigationMode(access);
  const isProductMarketingRole =
    access.role === "Product Manager" ||
    access.role === "Group Product Manager" ||
    access.role === "Marketing Manager";
  if (navigationMode !== "employee-portal" && !isProductMarketingRole) {
    redirect("/overview");
  }
  if (access.role === "Medical Rep") {
    redirect("/employee-portals/expenses");
  }

  await assertPermission(access, "outstation", "create");

  const [portalDataResult, outstationContextResult, teamPerformanceResult] = await Promise.allSettled([
    getEmployeePortalShellData(access),
    getOutstationEmployeeContext(access),
    getDsmTeamPerformance(access),
  ]);

  if (portalDataResult.status === "rejected") {
    return (
      <EmployeePortalEmptyState
        message="Unable to load your employee profile. Please contact HR to activate portal access."
        title="Portal Unavailable"
      />
    );
  }

  const portalData = portalDataResult.value;
  if (resolveJobFunctionRole(portalData.employee.roleLabel) === "Medical Rep") {
    redirect("/employee-portals/expenses");
  }
  const outstationContext = outstationContextResult.status === "fulfilled" ? outstationContextResult.value : null;
  const employeeName = outstationContext?.employeeName ?? portalData.employee.fullName;
  const employeeRole = outstationContext?.employeeRole ?? portalData.employee.roleLabel;
  const residenceSummary = buildResidenceSummary(outstationContext?.residence ?? null);
  const residenceShortSummary = buildResidenceShortSummary(outstationContext?.residence ?? null);
  const hasResidenceCoordinates = outstationContext?.residence
    ? outstationContext.residence.residenceLatitude !== null && outstationContext.residence.residenceLongitude !== null
    : false;
  const dsmTeamPerformance =
    teamPerformanceResult.status === "fulfilled"
      ? teamPerformanceResult.value
      : null;
  const medicalTripOptions =
    dsmTeamPerformance?.members.map((member) => ({
      hrId: member.hrId,
      name: member.name,
    })) ?? [];

  return (
    <EmployeePortalPageShell
      badge="Expenses"
      description="Capture outstation travel from the employee portal without duplicating the full admin expense workspace."
      errorBoundaryTitle="Submit Expense unavailable"
      title="Submit Expense"
    >
      <MobileOutstationWizard
        employeeHrId={access.hrId ?? portalData.employee.hrId}
        employeeName={employeeName}
        employeeRole={employeeRole}
        hasResidenceCoordinates={hasResidenceCoordinates}
        medicalTripOptions={medicalTripOptions}
        residenceShortSummary={residenceShortSummary}
        residenceSummary={residenceSummary}
        showIntro={false}
      />
    </EmployeePortalPageShell>
  );
}
