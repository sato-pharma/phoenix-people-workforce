import { redirect } from "next/navigation";

import { MobileOutstationWizard } from "@/components/outstation/mobile-outstation-wizard";
import { OutstationPendingActions } from "@/components/outstation/outstation-pending-actions";
import { SubmitExpenseMyClaims } from "@/components/outstation/submit-expense-my-claims";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { getDsmTeamPerformance, getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import {
  getOutstationEmployeeContext,
  getOwnOutstationPendingActions,
  listOwnOutstationSubmissions,
} from "@/lib/outstation/service";
import { getManagerAreaRepOptions } from "@/lib/outstation/area-rep-options";

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

  if (!(await canAccess(access, "outstation", "create"))) {
    redirect("/employee-portals/expenses");
  }

  const [
    portalDataResult,
    outstationContextResult,
    teamPerformanceResult,
    areaRepOptionsResult,
    pendingActionsResult,
    submissionsResult,
  ] = await Promise.allSettled([
    getEmployeePortalShellData(access),
    getOutstationEmployeeContext(access),
    getDsmTeamPerformance(access),
    getManagerAreaRepOptions(access),
    getOwnOutstationPendingActions(access),
    listOwnOutstationSubmissions(access),
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
  const areaRepOptions =
    areaRepOptionsResult.status === "fulfilled" ? areaRepOptionsResult.value : [];
  // What is still owed on claims already submitted leads the page: the departure photo and a missing
  // ticket are both taken HERE, on the screen people come back to (owner, 2026-10-22).
  const pendingActions =
    pendingActionsResult.status === "fulfilled"
      ? pendingActionsResult.value
      : { departurePhotoDue: [], missingTicket: [] };
  const employeeHrId = access.hrId ?? portalData.employee.hrId;
  // My claims sits under the form: Submit Expense and Expense Submissions are one page (owner,
  // 2026-10-22). A failed read is passed as null and said in words, never as an empty list.
  const submissions = submissionsResult.status === "fulfilled" ? submissionsResult.value : null;

  return (
    <EmployeePortalPageShell
      badge="Expenses"
      description="Submit an outstation expense step by step, then follow every claim you have made underneath."
      errorBoundaryTitle="Submit Expense unavailable"
      title="Submit Expense"
    >
      <div className="space-y-5">
        <OutstationPendingActions
          departurePhotoDue={pendingActions.departurePhotoDue}
          employeeHrId={employeeHrId}
          missingTicket={pendingActions.missingTicket}
        />
        <MobileOutstationWizard
          areaRepOptions={areaRepOptions}
          employeeHrId={employeeHrId}
          employeeName={employeeName}
          employeeRole={employeeRole}
          hasResidenceCoordinates={hasResidenceCoordinates}
          medicalTripOptions={medicalTripOptions}
          residenceShortSummary={residenceShortSummary}
          residenceSummary={residenceSummary}
        />
        <SubmitExpenseMyClaims employeeHrId={employeeHrId} submissions={submissions} />
      </div>
    </EmployeePortalPageShell>
  );
}
