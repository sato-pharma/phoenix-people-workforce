import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  FieldWorkforceRecommendationNotFoundError,
  fieldWorkforceDecisionStatuses,
  getFieldWorkforceRecommendationsReport,
  saveFieldWorkforceRecommendationDecision,
} from "@/lib/field-workforce-compliance/recommendations";
import type { FieldWorkforceDecisionStatus } from "@/lib/field-workforce-compliance/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

function actorFromAccess(access: Awaited<ReturnType<typeof resolveAccessContext>>) {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function isDecisionStatus(value: unknown): value is FieldWorkforceDecisionStatus {
  return typeof value === "string" && fieldWorkforceDecisionStatuses.includes(value as FieldWorkforceDecisionStatus);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");

    const { id } = await context.params;
    const url = new URL(request.url);
    const report = await getFieldWorkforceRecommendationsReport({
      actorLoginId: actorFromAccess(access),
      archiveId: id,
      auditFinalReportView: url.searchParams.get("report") === "final",
    });

    if (!report) {
      return NextResponse.json({
        error: "field_workforce_archive_not_found",
        message: "The archived Field Workforce Compliance month was not found.",
        success: false,
      }, { status: 404 });
    }

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

    return NextResponse.json({
      error: "field_workforce_recommendations_failed",
      message: error instanceof Error ? error.message : "Field Workforce Compliance recommendations failed.",
      success: false,
    }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "update");

    const body = await request.json().catch(() => null) as {
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

    const { id } = await context.params;
    const report = await saveFieldWorkforceRecommendationDecision({
      actorLoginId: actorFromAccess(access),
      archiveId: id,
      decisionStatus: body.decisionStatus,
      hrNote: typeof body.hrNote === "string" ? body.hrNote : "",
      recommendationKey: body.recommendationKey.trim(),
    });

    if (!report) {
      return NextResponse.json({
        error: "field_workforce_archive_not_found",
        message: "The archived Field Workforce Compliance month was not found.",
        success: false,
      }, { status: 404 });
    }

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

    if (error instanceof FieldWorkforceRecommendationNotFoundError) {
      return NextResponse.json({
        error: "recommendation_not_found",
        message: error.message,
        success: false,
      }, { status: 404 });
    }

    return NextResponse.json({
      error: "field_workforce_decision_update_failed",
      message: error instanceof Error ? error.message : "Field Workforce Compliance decision update failed.",
      success: false,
    }, { status: 500 });
  }
}
