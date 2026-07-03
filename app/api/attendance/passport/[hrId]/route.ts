import { NextResponse } from "next/server";

import { getAttendancePassport } from "@/lib/attendance/attendance-passport";
import { canAccessAttendanceSetup } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { hrIdsMatch } from "@/lib/hr-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ hrId: string }> }) {
  try {
    const { hrId } = await context.params;
    const access = await resolveAccessContext(request);

    const isSelf = hrIdsMatch(access.hrId, hrId);
    const isAdmin = await canAccessAttendanceSetup(access, "read");
    if (!isSelf && !isAdmin) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }

    return NextResponse.json(await getAttendancePassport(hrId));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance passport failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
