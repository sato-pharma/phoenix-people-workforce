import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { fieldWorkforceMonthKey } from "@/lib/field-workforce-compliance/archive";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function actorFromAccess(access: Awaited<ReturnType<typeof resolveAccessContext>>) {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function isDecisionStatus(value: unknown): value is FieldWorkforceDecisionStatus {
  return typeof value === "string" && fieldWorkforceDecisionStatuses.includes(value as FieldWorkforceDecisionStatus);
}

function parseIntField(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");

    const url = new URL(request.url);
    const month = parseIntField(url.searchParams.get("month"));
    const year = parseIntField(url.searchParams.get("year"));
    if (month === null || year === null) {
      return NextResponse.json({
        error: "missing_month_year",
        message: "Provide a month (1-12) and a year to view recommendations for.",
        success: false,
      }, { status: 400 });
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({ month, todayIso, year });
    const monthKey = fieldWorkforceMonthKey(preview.metadata.year, preview.metadata.month);
    const report = await buildFieldWorkforceRecommendationsReportForLiveMonth({ monthKey, preview });

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
      message: error instanceof Error ? error.message : "Field Workforce Compliance recommendations failed.",
      success: false,
    }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "update");

    const body = await request.json().catch(() => null) as {
      decisionReason?: unknown;
      decisionStatus?: unknown;
      hrNote?: unknown;
      month?: unknown;
      recommendationKey?: unknown;
      year?: unknown;
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
    const month = parseIntField(body.month);
    const year = parseIntField(body.year);
    if (month === null || year === null) {
      return NextResponse.json({
        error: "missing_month_year",
        message: "Provide a month (1-12) and a year to save this decision for.",
        success: false,
      }, { status: 400 });
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({ month, todayIso, year });
    const monthKey = fieldWorkforceMonthKey(preview.metadata.year, preview.metadata.month);
    const report = await saveFieldWorkforceRecommendationDecisionForLiveMonth({
      actorLoginId: actorFromAccess(access),
      decisionReason: typeof body.decisionReason === "string" ? body.decisionReason : "",
      decisionStatus: body.decisionStatus,
      hrNote: typeof body.hrNote === "string" ? body.hrNote : "",
      monthKey,
      preview,
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
      message: error instanceof Error ? error.message : "Field Workforce Compliance decision update failed.",
      success: false,
    }, { status: 500 });
  }
}
