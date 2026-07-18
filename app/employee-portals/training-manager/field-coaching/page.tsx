import { redirect } from "next/navigation";

import {
  CoachingReportsCenter,
  type CoachingReportsFilterOptions,
} from "@/components/coaching/coaching-reports-center";
import {
  EmployeePortalActionBar,
  EmployeePortalActionLink,
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import {
  canAccess,
  canManageCoachingReports,
  normalizeHrId,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import {
  resolveAccessContextFromPage,
  resolveViewerIdentityFromPage,
} from "@/lib/auth/server";
import { getCoachingReports } from "@/lib/coaching/service";
import type { CoachingReportSummaryRow } from "@/lib/coaching/types";
import {
  getEmployeeDirectoryRows,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { formatEmployeeDisplayName } from "@/lib/utils";

export const dynamic = "force-dynamic";

const createCoachingReportHref = "/employee-portals/training-manager/create-coaching-report";
const fieldCoachingHref = "/employee-portals/training-manager/field-coaching";

function toOptionMap(
  rows: { label: string | null | undefined; value: number | string | null | undefined }[],
) {
  const options = new Map<string, string>();
  for (const row of rows) {
    if (row.value === null || typeof row.value === "undefined") continue;
    const value = String(row.value);
    const label = row.label?.trim() || value;
    if (!options.has(value)) options.set(value, label);
  }
  return [...options.entries()]
    .map(([value, label]) => ({ label, value }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function buildFilterOptions(
  reports: CoachingReportSummaryRow[],
  employees: EmployeeDirectoryRow[],
): CoachingReportsFilterOptions {
  return {
    areas: toOptionMap([
      ...employees.map((employee) => ({ label: employee.areaName, value: employee.areaId })),
      ...reports.map((report) => ({ label: report.areaName, value: report.areaId })),
    ]),
    coaches: toOptionMap(reports.map((report) => ({
      label: `${formatEmployeeDisplayName(report.coachName, report.coachHrId)} (${formatHrIdForDisplay(report.coachHrId) ?? report.coachHrId})`,
      value: report.coachHrId,
    }))),
    lines: toOptionMap([
      ...employees.map((employee) => ({ label: employee.lineName, value: employee.lineId })),
      ...reports.map((report) => ({ label: report.lineName, value: report.lineId })),
    ]),
    medicalReps: toOptionMap([
      ...employees.map((employee) => ({
        label: `${formatEmployeeDisplayName(employee.displayName, employee.hrId)} (${formatHrIdForDisplay(employee.hrId) ?? employee.hrId})`,
        value: employee.hrId,
      })),
      ...reports.map((report) => ({
        label: `${formatEmployeeDisplayName(report.medicalRepName, report.medicalRepHrId)} (${formatHrIdForDisplay(report.medicalRepHrId) ?? report.medicalRepHrId})`,
        value: report.medicalRepHrId,
      })),
    ]),
    teams: toOptionMap(reports.map((report) => ({
      label: report.teamName || (report.teamId ? `Team ${report.teamId}` : null),
      value: report.teamId,
    }))),
  };
}

export default async function TrainingManagerFieldCoachingReportsPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (access.role !== "Training Manager") {
    redirect("/employee-portals");
  }

  if (!(await canAccess(access, "coaching", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to view Training Manager field coaching."
        title="Coaching Access Unavailable"
      />
    );
  }

  const coachHrId = normalizeHrId(access.hrId);
  if (!coachHrId) {
    return (
      <EmployeePortalEmptyState
        message="This Training Manager account needs a linked HR_ID before field coaching reports can be loaded."
        title="Training Manager Profile Unlinked"
      />
    );
  }

  let reports: CoachingReportSummaryRow[] = [];
  let employees: EmployeeDirectoryRow[] = [];
  let coachLabel = coachHrId;
  try {
    const [resolvedReports, resolvedEmployees, viewer] = await Promise.all([
      getCoachingReports({}, access),
      getEmployeeDirectoryRows(),
      resolveViewerIdentityFromPage(access),
    ]);
    reports = resolvedReports;
    employees = resolvedEmployees;
    coachLabel = viewer.displayName;
  } catch {
    return (
      <EmployeePortalEmptyState
        message="Unable to load Training Manager field coaching reports. Please try again later."
        title="Field Coaching Unavailable"
      />
    );
  }

  const canCreate =
    canManageCoachingReports(access) &&
    (await canAccess(access, "coaching", "create"));
  const canExport =
    canManageCoachingReports(access) ||
    (await canAccess(access, "coaching", "export"));

  return (
    <EmployeePortalPageShell
      badge="Coaching"
      description="Review field coaching reports, filter by employee context, export XLSX files, and inspect scoring outcomes without leaving the employee portal."
      title="Field Coaching"
    >
      {canCreate ? (
        <EmployeePortalActionBar
          actions={<EmployeePortalActionLink href={createCoachingReportHref} label="Create Coaching Report" />}
        />
      ) : null}

      <CoachingReportsCenter
        canCreate={canCreate}
        canExport={canExport}
        createHref={createCoachingReportHref}
        detailHrefBase={fieldCoachingHref}
        filterOptions={buildFilterOptions(reports, employees)}
        initialReports={reports}
        lockedCoachHrId={access.hrId}
        lockedCoachLabel={coachLabel}
      />
    </EmployeePortalPageShell>
  );
}
