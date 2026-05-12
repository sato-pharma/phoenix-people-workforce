import { BarChart3, ClipboardCheck, Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  AdminInsightChip,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import {
  CoachingAnalyticsDashboard,
  type CoachingAnalyticsFilterOptions,
  type CoachingAnalyticsPayload,
} from "@/components/coaching/coaching-analytics-dashboard";
import { AppShell } from "@/components/layout/app-shell";
import {
  canAccess,
  canManageCoachingReports,
  normalizeHrId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getCoachingQuarterlySummary,
  getCoachingReports,
  getCoachingScoreAnalyticsForReports,
} from "@/lib/coaching/service";
import type {
  CoachingQuarterlySummaryRow,
  CoachingReportSummaryRow,
} from "@/lib/coaching/types";
import {
  getEmployeeDirectoryRows,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { formatEmployeeDisplayName } from "@/lib/utils";

export const dynamic = "force-dynamic";

const completedStatuses = new Set(["submitted", "reviewed_by_employee", "locked"]);

function isEmployeePortalRole(access: AccessContext) {
  return access.role === "Employee" || access.role === "Medical Rep";
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function buildAnalytics(reports: CoachingReportSummaryRow[]) {
  const completed = reports.filter((report) => completedStatuses.has(report.status));
  const scores = completed.map((report) => report.finalScorePercent).filter(Number.isFinite);
  const zoneCounts = completed.reduce<Record<string, number>>((accumulator, report) => {
    const zone = report.performanceZone ?? "unclassified";
    accumulator[zone] = (accumulator[zone] ?? 0) + 1;
    return accumulator;
  }, {});

  return {
    averageScore: average(scores),
    bestScore: scores.length ? Math.max(...scores) : 0,
    coachingCount: completed.length,
    draftCount: reports.filter((report) => report.status === "draft").length,
    latestReport: completed[0] ?? null,
    lowestScore: scores.length ? Math.min(...scores) : 0,
    pendingAcknowledgmentCount: completed.filter((report) => report.status === "submitted" && !report.acknowledged).length,
    zoneCounts,
  };
}

function filterQuarterlyByReports(
  quarterlySummary: CoachingQuarterlySummaryRow[],
  reports: CoachingReportSummaryRow[],
) {
  const visibleHrIds = new Set(reports.map((report) => report.medicalRepHrId.toLowerCase()));
  return quarterlySummary.filter((row) => visibleHrIds.has(row.medicalRepHrId.toLowerCase()));
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
  quarterlySummary: CoachingQuarterlySummaryRow[],
  employees: EmployeeDirectoryRow[],
): CoachingAnalyticsFilterOptions {
  return {
    areas: toOptionMap([
      ...employees.map((employee) => ({ label: employee.areaName, value: employee.areaId })),
      ...reports.map((report) => ({ label: report.areaName, value: report.areaId })),
    ]),
    lines: toOptionMap([
      ...employees.map((employee) => ({ label: employee.lineName, value: employee.lineId })),
      ...reports.map((report) => ({ label: report.lineName, value: report.lineId })),
    ]),
    medicalReps: toOptionMap([
      ...employees.map((employee) => ({
        label: `${formatEmployeeDisplayName(employee.fullName, employee.hrId)} (${employee.hrId})`,
        value: employee.hrId,
      })),
      ...reports.map((report) => ({
        label: `${formatEmployeeDisplayName(report.medicalRepName, report.medicalRepHrId)} (${report.medicalRepHrId})`,
        value: report.medicalRepHrId,
      })),
    ]),
    teams: toOptionMap(reports.map((report) => ({
      label: report.teamName || (report.teamId ? `Team ${report.teamId}` : null),
      value: report.teamId,
    }))),
    years: toOptionMap([
      ...reports.map((report) => ({ label: String(report.coachingYear), value: report.coachingYear })),
      ...quarterlySummary.map((row) => ({ label: String(row.year), value: row.year })),
      { label: String(new Date().getFullYear()), value: new Date().getFullYear() },
    ]).sort((left, right) => Number(right.value) - Number(left.value)),
  };
}

export default async function CoachingAnalyticsPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (isEmployeePortalRole(access)) {
    redirect("/employee-portals/coaching");
  }
  if (!(await canAccess(access, "coaching", "read"))) {
    redirect("/admin/access");
  }

  const canCreate =
    canManageCoachingReports(access) &&
    (await canAccess(access, "coaching", "create"));
  const lockedCoachHrId = access.role === "Training Manager" ? normalizeHrId(access.hrId) : null;
  const initialFilters = lockedCoachHrId ? { coachHrId: lockedCoachHrId } : {};

  const [reports, quarterlySummary, employees] = await Promise.all([
    getCoachingReports(initialFilters, access),
    getCoachingQuarterlySummary({}, access),
    getEmployeeDirectoryRows(),
  ]);

  const visibleQuarterlySummary = filterQuarterlyByReports(quarterlySummary, reports);
  const scoreAnalytics = await getCoachingScoreAnalyticsForReports(reports);
  const payload: CoachingAnalyticsPayload = {
    analytics: buildAnalytics(reports),
    ...scoreAnalytics,
    quarterlySummary: visibleQuarterlySummary,
    reports,
  };

  return (
    <AppShell navigationMode="admin">
      <div className="space-y-6">
        <AdminPageHero
          actions={
            <div className="flex flex-wrap gap-2">
              <Link
                className="inline-flex items-center justify-center gap-2 rounded-full border border-[#CBD5E1] bg-white px-5 py-2.5 text-sm font-black text-[#0F172A] shadow-sm transition hover:border-[#F97316]/50 hover:text-[#F97316]"
                href="/coaching"
              >
                <ClipboardCheck className="h-4 w-4" />
                Back to Reports Center
              </Link>
              {canCreate ? (
                <Link
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-[#F97316] px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_42px_rgba(249,115,22,0.22)] transition hover:bg-[#EA580C]"
                  href="/coaching/new"
                >
                  <Plus className="h-4 w-4" />
                  Create Coaching Report
                </Link>
              ) : null}
            </div>
          }
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip>Quarterly intelligence</AdminInsightChip>
              <AdminInsightChip tone="orange">Field Excellence</AdminInsightChip>
              <AdminInsightChip tone="slate">Development progress</AdminInsightChip>
            </div>
          }
          description="Track field coaching performance, development progress, and quarterly improvement trends."
          eyebrow="Coaching"
          icon={<BarChart3 className="h-3.5 w-3.5" />}
          title="Coaching Analytics"
        />

        <CoachingAnalyticsDashboard
          canCreate={canCreate}
          filterOptions={buildFilterOptions(reports, visibleQuarterlySummary, employees)}
          initialData={payload}
        />
      </div>
    </AppShell>
  );
}
