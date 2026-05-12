import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getLeaveTypes, upsertLeaveType } from "@/lib/leave/service";

export async function GET() {
  try {
    const leaveTypes = await getLeaveTypes(true);
    return NextResponse.json({ leaveTypes });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load leave types." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const leaveType = await upsertLeaveType(access, body);
    return NextResponse.json({ leaveType });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save leave type." }, { status: 400 });
  }
}
