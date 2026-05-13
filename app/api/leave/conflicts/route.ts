import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { previewLeaveConflicts } from "@/lib/leave/service";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({}));
    const conflicts = await previewLeaveConflicts(access, {
      endDate: String(body.endDate ?? ""),
      startDate: String(body.startDate ?? ""),
    });
    return NextResponse.json({ conflicts });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to preview leave conflicts." }, { status: 400 });
  }
}
