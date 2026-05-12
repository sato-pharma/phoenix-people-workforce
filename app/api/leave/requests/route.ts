import { mkdir, writeFile } from "fs/promises";
import path from "path";

import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
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
    line: params.get("line") || undefined,
    managerHrId: params.get("managerHrId") || undefined,
    month: params.get("month") ? Number(params.get("month")) : undefined,
    startDate: params.get("startDate") || undefined,
    status: params.get("status") || undefined,
    year: params.get("year") ? Number(params.get("year")) : undefined,
  };
}

async function saveAttachment(file: File | null) {
  if (!file || file.size === 0) return null;
  const extension = path.extname(file.name).slice(0, 12) || ".bin";
  const cleanName = `${crypto.randomUUID()}${extension}`;
  const directory = path.join(process.cwd(), "public", "uploads", "leave");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, cleanName), Buffer.from(await file.arrayBuffer()));
  return `/uploads/leave/${cleanName}`;
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
      const requestRecord = await submitLeaveRequest(access, {
        attachmentUrl: await saveAttachment(formData.get("attachment") instanceof File ? formData.get("attachment") : null),
        endDate: String(formData.get("endDate") ?? ""),
        leaveTypeId: String(formData.get("leaveTypeId") ?? ""),
        reason: String(formData.get("reason") ?? ""),
        startDate: String(formData.get("startDate") ?? ""),
      });
      return NextResponse.json({ request: requestRecord });
    }

    const body = await request.json();
    const requestRecord = await submitLeaveRequest(access, body);
    return NextResponse.json({ request: requestRecord });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit leave request." }, { status: 400 });
  }
}
