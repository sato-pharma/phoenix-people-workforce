import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { uploadLeaveAttachment } from "@/lib/leave/attachments";
import { listLeaveRequests, submitLeaveRequest } from "@/lib/leave/service";
import type { LeaveRequestFilters } from "@/lib/leave/types";

function searchFilters(url: string): LeaveRequestFilters {
  const params = new URL(url).searchParams;
  return {
    area: params.get("area") || undefined,
    employee: params.get("employee") || undefined,
    employeeHrId: params.get("employeeHrId") || undefined,
    endDate: params.get("endDate") || undefined,
    leaveTypeId: params.get("leaveTypeId") || undefined,
    limit: params.get("limit") ? Number(params.get("limit")) : undefined,
    line: params.get("line") || undefined,
    managerHrId: params.get("managerHrId") || undefined,
    month: params.get("month") ? Number(params.get("month")) : undefined,
    offset: params.get("offset") ? Number(params.get("offset")) : undefined,
    startDate: params.get("startDate") || undefined,
    status: params.get("status") || undefined,
    year: params.get("year") ? Number(params.get("year")) : undefined,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const requests = await listLeaveRequests(access, searchFilters(request.url));
    return NextResponse.json({ requests });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load leave requests." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const attachment = formData.get("attachment");
      const requestRecord = await submitLeaveRequest(access, {
        attachmentUrl: await uploadLeaveAttachment(attachment instanceof File ? attachment : null, access.hrId ?? "UNKNOWN"),
        durationUnit: String(formData.get("durationUnit") ?? "full_day") as "full_day" | "am" | "pm",
        endDate: String(formData.get("endDate") ?? ""),
        leaveTypeId: String(formData.get("leaveTypeId") ?? ""),
        reason: String(formData.get("reason") ?? ""),
        startDate: String(formData.get("startDate") ?? ""),
      });
      return NextResponse.json(requestRecord);
    }

    const body = await request.json();
    const requestRecord = await submitLeaveRequest(access, {
      durationUnit: String(body.durationUnit ?? "full_day") as "full_day" | "am" | "pm",
      endDate: String(body.endDate ?? ""),
      leaveTypeId: String(body.leaveTypeId ?? ""),
      reason: typeof body.reason === "string" ? body.reason : null,
      startDate: String(body.startDate ?? ""),
    });
    return NextResponse.json(requestRecord);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit leave request." }, { status: 400 });
  }
}
