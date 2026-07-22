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
    const dispute = await submitPrivateCalendarDataDispute(access, {
      claimSourceText: String(body.claimSourceText ?? ""),
      claimText: String(body.claimText ?? ""),
      disputeDate: String(body.disputeDate ?? ""),
      displayedSummary: String(body.displayedSummary ?? ""),
      employeeName: typeof body.employeeName === "string" ? body.employeeName : null,
      itemSource: typeof body.itemSource === "string" ? body.itemSource : null,
      itemSourceRecordId: typeof body.itemSourceRecordId === "string" ? body.itemSourceRecordId : null,
    });
    return NextResponse.json({ data: dispute, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to submit this dispute.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
