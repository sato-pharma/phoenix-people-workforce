import { NextResponse } from "next/server";

import { submitCoachingReport } from "@/lib/coaching/service";
import { createSystemNotification } from "@/lib/notifications/system";
import {
  jsonError,
  readJsonObject,
  requireCoachingManagementPermission,
  submitInput,
} from "@/app/api/coaching/_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const access = await requireCoachingManagementPermission(request, "update");
    const { id } = await context.params;
    const payload = await readJsonObject(request, { allowEmpty: true });
    const report = await submitCoachingReport(id, submitInput(payload), access);
    const coachName = report.summary?.coachName || report.report.coach_hr_id;
    const notification = await createSystemNotification({
      actionUrl: `/employee-portals/coaching/${report.report.id}`,
      category: "coaching_report",
      eventType: "report_submitted",
      message: `You have received a new coaching report from ${coachName}. Please review and acknowledge it.`,
      metadata: {
        coachHrId: report.report.coach_hr_id,
        coachName,
        idempotencyKey: `coaching_report_submitted:${report.report.id}:${report.report.medical_rep_hr_id}`,
        reportId: report.report.id,
        reportNumber: report.report.report_number,
      },
      module: "coaching",
      priority: "normal",
      recipientHrId: report.report.medical_rep_hr_id,
      title: "New Coaching Report",
    });

    return NextResponse.json({
      data: report,
      message: "Coaching report submitted.",
      notification,
      success: true,
    });
  } catch (error) {
    return jsonError(error, "Failed to submit coaching report.");
  }
}
