import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  getFieldWorkforceComplianceLiveSnapshot,
  summarizeFieldWorkforceMirrorFreshness,
} from "@/lib/field-workforce-compliance/live-snapshots";
import { FieldWorkforcePreviewError } from "@/lib/field-workforce-compliance/preview";
import { getLatestVisitsSyncRuns } from "@/lib/visits-report/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const monthKeyPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

type RouteContext = {
  params: Promise<{
    monthKey: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");

    const { monthKey } = await context.params;
    if (!monthKeyPattern.test(monthKey)) {
      return NextResponse.json({
        error: "invalid_month_key",
        message: "monthKey must be in YYYY-MM form.",
        success: false,
      }, { status: 400 });
    }

    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get("force") === "true";

    const snapshot = await getFieldWorkforceComplianceLiveSnapshot({ forceRefresh, monthKey });

    // Mirror freshness so the UI can warn when this month's data may be incomplete (a stale
    // sync or the still-open current month) before HR acts on any "N" day.
    const syncRuns = await getLatestVisitsSyncRuns(10);
    const mirrorFreshness = summarizeFieldWorkforceMirrorFreshness({
      monthKey,
      nowIso: new Date().toISOString(),
      runs: syncRuns.map((run) => ({
        completedAt: run.completedAt,
        startedAt: run.startedAt,
        status: run.status,
      })),
    });

    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: monthKey,
      entityType: "field_workforce_compliance_import",
      newValues: {
        employeeCount: snapshot.employeeCount,
        forceRefresh,
        highSeverityCount: snapshot.highSeverityCount,
        monthKey,
        reviewCandidateCount: snapshot.reviewCandidateCount,
        source: "ireports360_visits_mirror",
      },
      summary: forceRefresh
        ? "Field Workforce Compliance live snapshot recomputed on demand."
        : "Field Workforce Compliance live snapshot viewed.",
    });

    return NextResponse.json({
      data: snapshot,
      mirrorFreshness,
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to view Field Workforce Compliance data.",
        success: false,
      }, { status: 403 });
    }

    if (error instanceof FieldWorkforcePreviewError) {
      return NextResponse.json({
        error: error.code,
        errors: error.errors,
        message: error.message,
        success: false,
        warnings: error.warnings,
      }, { status: error.status });
    }

    return NextResponse.json({
      error: "field_workforce_live_snapshot_failed",
      message: error instanceof Error ? error.message : "Field Workforce Compliance snapshot could not be loaded.",
      success: false,
    }, { status: 500 });
  }
}
