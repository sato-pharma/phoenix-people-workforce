import { NextResponse } from "next/server";

import {
  getCoachingReportById,
  updateDraftCoachingReport,
} from "@/lib/coaching/service";
import {
  jsonError,
  mutationInput,
  readJsonObject,
  requireCoachingManagementPermission,
  requireCoachingPermission,
  CoachingApiError,
} from "@/app/api/coaching/_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await requireCoachingPermission(request, "read");
    const { id } = await context.params;
    const report = await getCoachingReportById(id, access);

    return NextResponse.json({
      data: report,
      success: true,
    });
  } catch (error) {
    return jsonError(error, "Failed to load coaching report.");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const access = await requireCoachingManagementPermission(request, "update");
    const { id } = await context.params;
    const payload = await readJsonObject(request);
    const input = mutationInput(payload);
    if (Object.keys(input).length === 0) {
      throw new CoachingApiError("validation_error", "No valid coaching fields were provided.", 400);
    }
    const report = await updateDraftCoachingReport(id, input, access);

    return NextResponse.json({
      data: report,
      message: "Coaching draft report updated.",
      success: true,
    });
  } catch (error) {
    return jsonError(error, "Failed to update coaching report.");
  }
}
