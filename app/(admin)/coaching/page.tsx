import { ClipboardCheck, ListChecks } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  AdminInsightChip,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import {
  CoachingReportsCenter,
  type CoachingReportsFilterOptions,
} from "@/components/coaching/coaching-reports-center";
import {
  canAccess,
  canManageCoachingReports,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenSkillsSurvey } from "@/lib/coaching/skills-survey/access";
import { getCoachingReports } from "@/lib/coaching/service";
import type { CoachingReportSummaryRow } from "@/lib/coaching/types";
import {
  getEmployeeDirectoryRows,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { formatEmployeeDisplayName } from "@/lib/utils";

export const dynamic = "force-dynamic";

function isEmployeePortalRole(access: AccessContext) {
  return access.role === "Employee" || access.role === "Medical Rep";
}

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

export default async function CoachingReportsPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (access.role === "Training Manager") {
    redirect("/employee-portals/training-manager/field-coaching");
  }
  if (isEmployeePortalRole(access)) {
    redirect("/employee-portals/coaching");
  }
  if (!(await canAccess(access, "coaching", "read"))) {
    redirect("/admin/access");
  }

  // The old coaching form takes no new reports (owner, 2026-10-31); its button now opens the survey.
  const showSkillsSurveyLink =
    canOpenSkillsSurvey(access) && (await canAccess(access, "coaching_skills_survey", "read"));
  const canExport =
    canManageCoachingReports(access) ||
    (await canAccess(access, "coaching", "export"));
  const reports = await getCoachingReports({}, access);

  const employees = await getEmployeeDirectoryRows();

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={
            showSkillsSurveyLink ? (
              <Link
                className="inline-flex items-center justify-center gap-2 rounded-full bg-phx-accent px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_42px_rgba(249,115,22,0.22)] transition hover:bg-phx-accent-hover"
                href="/coaching/skills-survey"
              >
                <ListChecks className="h-4 w-4" />
                Team Coaching Skills Survey
              </Link>
            ) : null
          }
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip>Reports Center</AdminInsightChip>
              <AdminInsightChip tone="orange">Field Excellence</AdminInsightChip>
              <AdminInsightChip tone="slate">Read-only review workspace</AdminInsightChip>
            </div>
          }
          description="Review field coaching reports, filter by employee context, and inspect scoring outcomes without changing submitted coaching data."
          eyebrow="Coaching"
          icon={<ClipboardCheck className="h-3.5 w-3.5" />}
          title="Field Coaching"
        />

        <CoachingReportsCenter
          showSkillsSurveyLink={showSkillsSurveyLink}
          canExport={canExport}
          filterOptions={buildFilterOptions(reports, employees)}
          initialReports={reports}
          lockedCoachHrId={null}
          lockedCoachLabel={null}
        />
    </div>
  );
}
