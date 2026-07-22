import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { submitNoActivityClarification } from "@/lib/private-calendar/no-activity-clarifications";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const clarification = await submitNoActivityClarification(access, {
      activityDate: String(body.activityDate ?? ""),
      clarificationText: typeof body.clarificationText === "string" ? body.clarificationText : null,
      confirmedNoActivity: Boolean(body.confirmedNoActivity),
      employeeName: typeof body.employeeName === "string" ? body.employeeName : null,
      sourcePointerText: typeof body.sourcePointerText === "string" ? body.sourcePointerText : null,
    });
    return NextResponse.json({ data: clarification, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to submit this clarification.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
