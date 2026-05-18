import { NextResponse } from "next/server";

import {
  getCoachingQuarterlySummary,
  getCoachingReports,
  getCoachingScoreAnalyticsForReports,
} from "@/lib/coaching/service";
import {
  buildCoachingReportAnalytics,
  filterCoachingQuarterlySummaryByReports,
} from "@/lib/coaching/analytics";
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

const defaultAnalyticsReportLimit = 500;

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
        analytics: buildCoachingReportAnalytics(reports),
        ...scoreAnalytics,
        quarterlySummary: filterCoachingQuarterlySummaryByReports(quarterlySummary, reports, hasOrgFilters || Boolean(filters.coachHrId)),
        reports,
      },
      success: true,
    });
  } catch (error) {
    return jsonError(error, "Failed to load coaching analytics.");
  }
}
