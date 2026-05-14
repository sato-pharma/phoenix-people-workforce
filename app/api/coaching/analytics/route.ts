import { NextResponse } from "next/server";

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
  type AccessContext,
  normalizeHrId,
} from "@/lib/auth/permissions";
import {
  filtersFromRequest,
  jsonError,
  requireCoachingPermission,
} from "@/app/api/coaching/_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const completedStatuses = new Set(["submitted", "reviewed_by_employee", "locked"]);
const defaultAnalyticsReportLimit = 500;

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
  hasOrgFilters: boolean,
) {
  if (!hasOrgFilters) return quarterlySummary;
  const visibleHrIds = new Set(reports.map((report) => report.medicalRepHrId.toLowerCase()));
  return quarterlySummary.filter((row) => visibleHrIds.has(row.medicalRepHrId.toLowerCase()));
}

function enforceAnalyticsScope(filters: ReturnType<typeof filtersFromRequest>, access: AccessContext) {
  const scopedFilters = {
    ...filters,
    limit: filters.limit ?? defaultAnalyticsReportLimit,
  };
  if (access.role !== "Training Manager") return scopedFilters;
  const coachHrId = normalizeHrId(access.hrId);
  return {
    ...scopedFilters,
    coachHrId: coachHrId ?? "__no_training_manager_hr_id__",
  };
}

export async function GET(request: Request) {
  try {
    const access = await requireCoachingPermission(request, "read");
    const filters = enforceAnalyticsScope(filtersFromRequest(request), access);
    const reports = await getCoachingReports(filters, access);
    const [quarterlySummary, scoreAnalytics] = await Promise.all([
      getCoachingQuarterlySummary({
        medicalRepHrId: filters.medicalRepHrId,
        quarter: filters.quarter,
        year: filters.year,
      }, access),
      getCoachingScoreAnalyticsForReports(reports),
    ]);
    const hasOrgFilters = Boolean(filters.lineId || filters.areaId || filters.teamId);

    return NextResponse.json({
      data: {
        analytics: buildAnalytics(reports),
        ...scoreAnalytics,
        quarterlySummary: filterQuarterlyByReports(quarterlySummary, reports, hasOrgFilters || Boolean(filters.coachHrId)),
        reports,
      },
      success: true,
    });
  } catch (error) {
    return jsonError(error, "Failed to load coaching analytics.");
  }
}
