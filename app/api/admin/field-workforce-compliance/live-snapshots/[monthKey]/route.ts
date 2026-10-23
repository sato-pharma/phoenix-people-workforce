import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { resolveVendorSyncStandDown } from "@/lib/crm/cutover";
import {
  getFieldWorkforceComplianceLiveView,
  summarizeFieldWorkforceMirrorFreshness,
} from "@/lib/field-workforce-compliance/live-snapshots";
import { FieldWorkforcePreviewError } from "@/lib/field-workforce-compliance/preview";
import { getLatestVisitsSyncRuns } from "@/lib/visits-report/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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
    // Fenced off the Talent Acquisition seat with its page (seat-page-fences.ts, audit P7-01).
    assertPageOpenForRole(access.role, "/admin/field-workforce-compliance");

    const { monthKey } = await context.params;
    if (!monthKeyPattern.test(monthKey)) {
      return NextResponse.json({
        error: "invalid_month_key",
        message: "monthKey must be in YYYY-MM form.",
        success: false,
      }, { status: 400 });
    }

    const snapshot = await getFieldWorkforceComplianceLiveView({ monthKey });

    // Mirror freshness so the UI can warn when this month's data may be incomplete (a stale
    // sync or the still-open current month) before HR acts on any "N" day.
    // After the CRM cutover retires iReports360 the sync ledger stops growing by design, so it must
    // not raise the stale warning. An unreadable setting answers null: the warning behaves as before.
    const [syncRuns, vendorStandDown] = await Promise.all([getLatestVisitsSyncRuns(10), resolveVendorSyncStandDown()]);
    const mirrorFreshness = summarizeFieldWorkforceMirrorFreshness({
      monthKey,
      nowIso: new Date().toISOString(),
      runs: syncRuns.map((run) => ({
        completedAt: run.completedAt,
        startedAt: run.startedAt,
        status: run.status,
      })),
      vendorSyncRetired: vendorStandDown !== null,
    });

    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: monthKey,
      entityType: "field_workforce_compliance_import",
      newValues: {
        employeeCount: snapshot.employeeCount,
        highSeverityCount: snapshot.highSeverityCount,
        monthKey,
        reviewCandidateCount: snapshot.reviewCandidateCount,
        source: "ireports360_visits_mirror",
      },
      summary: "Field Workforce Compliance live view computed.",
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
      error: "field_workforce_live_view_failed",
      message: clientSafeErrorMessage(error, "Field Workforce Compliance data could not be computed."),
      success: false,
    }, { status: 500 });
  }
}
