import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { adjustLeaveBalance } from "@/lib/leave/service";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const balance = await adjustLeaveBalance(access, {
      amount: Number(body.amount),
      employeeHrId: String(body.employeeHrId ?? ""),
      leaveTypeId: String(body.leaveTypeId ?? ""),
      reason: String(body.reason ?? ""),
      year: body.year ? Number(body.year) : undefined,
    });
    return NextResponse.json({ balance });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to adjust leave balance." }, { status: 400 });
  }
}
