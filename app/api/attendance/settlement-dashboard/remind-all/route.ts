import { NextResponse } from "next/server";

import { remindAllPendingDigests } from "@/lib/attendance/settlement-dashboard";
import { assertAttendanceSetupPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "update");

    const payload = await request.json().catch(() => ({}));
    const cycleKey = typeof (payload as { cycleKey?: unknown }).cycleKey === "string" ? (payload as { cycleKey: string }).cycleKey : undefined;

    return NextResponse.json(await remindAllPendingDigests(cycleKey));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Remind-all failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
