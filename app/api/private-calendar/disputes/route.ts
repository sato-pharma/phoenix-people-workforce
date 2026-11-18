import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { listMyPrivateCalendarDataDisputes, submitPrivateCalendarDataDispute } from "@/lib/private-calendar/disputes";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const disputes = await listMyPrivateCalendarDataDisputes(access);
    return NextResponse.json({ data: disputes, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to load your disputes.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    // The explanation (owner, 2026-11-16): a reason from the list, the days, who confirms, and words
    // for "Something else". The domain helper checks every field; nothing here trusts the body.
    const summaries: Record<string, string> = {};
    if (body.displayedSummaries && typeof body.displayedSummaries === "object") {
      for (const [date, text] of Object.entries(body.displayedSummaries as Record<string, unknown>)) {
        if (typeof text === "string") summaries[String(date)] = text.slice(0, 500);
      }
    }
    const disputes = await submitPrivateCalendarDataDispute(access, {
      confirmerHrId: body.confirmerHrId,
      dates: body.dates,
      detailText: body.detailText,
      displayedSummaries: summaries,
      reasonCode: body.reasonCode,
    });
    return NextResponse.json({ data: disputes, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to send this explanation.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
