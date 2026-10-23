import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getFieldWorkforceComplianceLiveView } from "@/lib/field-workforce-compliance/live-snapshots";
import { FieldWorkforcePreviewError } from "@/lib/field-workforce-compliance/preview";
import {
  FieldWorkforceConflictingDecisionError,
  FieldWorkforceDecisionReasonError,
  FieldWorkforceInvalidDecisionStatusError,
  FieldWorkforceRecommendationNotFoundError,
  buildFieldWorkforceRecommendationsReportForLiveMonth,
  fieldWorkforceDecisionStatuses,
  saveFieldWorkforceRecommendationDecisionForLiveMonth,
} from "@/lib/field-workforce-compliance/recommendations";
import type { FieldWorkforceDecisionStatus } from "@/lib/field-workforce-compliance/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const monthKeyPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

type RouteContext = {
  params: Promise<{
    monthKey: string;
  }>;
};

function actorFromAccess(access: Awaited<ReturnType<typeof resolveAccessContext>>) {
  return hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function isDecisionStatus(value: unknown): value is FieldWorkforceDecisionStatus {
  return typeof value === "string" && fieldWorkforceDecisionStatuses.includes(value as FieldWorkforceDecisionStatus);
}

function invalidMonthKeyResponse() {
  return NextResponse.json({
    error: "invalid_month_key",
    message: "monthKey must be in YYYY-MM form.",
    success: false,
  }, { status: 400 });
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");
    // Fenced off the Talent Acquisition seat with its page (seat-page-fences.ts, audit P7-01).
    assertPageOpenForRole(access.role, "/admin/field-workforce-compliance");

    const { monthKey } = await context.params;
    if (!monthKeyPattern.test(monthKey)) return invalidMonthKeyResponse();

    const snapshot = await getFieldWorkforceComplianceLiveView({ monthKey });
    const report = await buildFieldWorkforceRecommendationsReportForLiveMonth({ monthKey, preview: snapshot.preview });

    return NextResponse.json({
      data: report,
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to view Field Workforce Compliance recommendations.",
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
      error: "field_workforce_recommendations_failed",
      message: clientSafeErrorMessage(error, "Field Workforce Compliance recommendations failed."),
      success: false,
    }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "update");
    // Fenced off the Talent Acquisition seat with its page (seat-page-fences.ts, audit P7-01).
    assertPageOpenForRole(access.role, "/admin/field-workforce-compliance");

    const { monthKey } = await context.params;
    if (!monthKeyPattern.test(monthKey)) return invalidMonthKeyResponse();

    const body = await request.json().catch(() => null) as {
      decisionReason?: unknown;
      decisionStatus?: unknown;
      hrNote?: unknown;
      recommendationKey?: unknown;
    } | null;
    if (!body || typeof body.recommendationKey !== "string" || !body.recommendationKey.trim()) {
      return NextResponse.json({
        error: "invalid_recommendation_key",
        message: "A recommendation key is required.",
        success: false,
      }, { status: 400 });
    }
    if (!isDecisionStatus(body.decisionStatus)) {
      return NextResponse.json({
        error: "invalid_decision_status",
        message: "Choose a supported HR decision status.",
        success: false,
      }, { status: 400 });
    }

    const snapshot = await getFieldWorkforceComplianceLiveView({ monthKey });
    const report = await saveFieldWorkforceRecommendationDecisionForLiveMonth({
      actorLoginId: actorFromAccess(access),
      decisionReason: typeof body.decisionReason === "string" ? body.decisionReason : "",
      decisionStatus: body.decisionStatus,
      hrNote: typeof body.hrNote === "string" ? body.hrNote : "",
      monthKey,
      preview: snapshot.preview,
      recommendationKey: body.recommendationKey.trim(),
    });

    return NextResponse.json({
      data: report,
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to update Field Workforce Compliance decisions.",
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

    if (error instanceof FieldWorkforceRecommendationNotFoundError) {
      return NextResponse.json({
        error: "recommendation_not_found",
        message: error.message,
        success: false,
      }, { status: 404 });
    }

    if (
      error instanceof FieldWorkforceInvalidDecisionStatusError ||
      error instanceof FieldWorkforceDecisionReasonError ||
      error instanceof FieldWorkforceConflictingDecisionError
    ) {
      return NextResponse.json({
        error: "invalid_decision",
        message: error.message,
        success: false,
      }, { status: 400 });
    }

    return NextResponse.json({
      error: "field_workforce_decision_update_failed",
      message: clientSafeErrorMessage(error, "Field Workforce Compliance decision update failed."),
      success: false,
    }, { status: 500 });
  }
}
