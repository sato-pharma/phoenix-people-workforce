import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { decideLeaveAsManager } from "@/lib/leave/service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const { id } = await params;
    const body = await request.json();
    const leaveRequest = await decideLeaveAsManager(access, id, body);
    return NextResponse.json({ request: leaveRequest });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to record manager decision." }, { status: 400 });
  }
}
