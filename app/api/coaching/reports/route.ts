import { NextResponse } from "next/server";

import {
  createDraftCoachingReport,
  getCoachingReports,
} from "@/lib/coaching/service";
import {
  createReportInput,
  filtersFromRequest,
  jsonError,
  readJsonObject,
  requireCoachingManagementPermission,
  requireCoachingPermission,
} from "@/app/api/coaching/_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await requireCoachingPermission(request, "read");
    const filters = filtersFromRequest(request);
    const reports = await getCoachingReports(filters, access);

    return NextResponse.json({
      data: reports,
      success: true,
    });
  } catch (error) {
    return jsonError(error, "Failed to load coaching reports.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireCoachingManagementPermission(request, "create");
    const payload = await readJsonObject(request);
    const report = await createDraftCoachingReport(createReportInput(payload), access);

    return NextResponse.json(
      {
        data: report,
        message: "Coaching draft report created.",
        success: true,
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, "Failed to create coaching report.");
  }
}
