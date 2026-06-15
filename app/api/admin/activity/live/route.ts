export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { resolveAccessContext, isForbiddenError } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { getLiveActivity } from "@/lib/activity/service";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ message: "Not authenticated" }, { status: 401 });
    }
    await assertPermission(access, "user_activity", "read");

    const live = await getLiveActivity();
    return NextResponse.json({ live });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: "Forbidden" }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Failed to load live activity";
    return NextResponse.json({ message }, { status: 500 });
  }
}
