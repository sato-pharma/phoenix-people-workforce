import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { cancelLeaveRequest, getLeaveRequestDetails } from "@/lib/leave/service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const { id } = await params;
    const leaveRequest = await getLeaveRequestDetails(access, id);
    return NextResponse.json({ request: leaveRequest });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load leave request." }, { status: 404 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const leaveRequest = await cancelLeaveRequest(access, id, body.comment);
    return NextResponse.json({ request: leaveRequest });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update leave request." }, { status: 400 });
  }
}
