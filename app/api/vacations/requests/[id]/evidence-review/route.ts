import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  isVacationSchemaMissing,
  reviewVacationEvidence,
  vacationErrorMessage,
} from "@/lib/vacation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const review = await reviewVacationEvidence(access, {
      evidenceType: body.evidenceType,
      requestId: id,
      reviewNote: body.reviewNote,
      status: body.status,
    });
    return NextResponse.json({ review, success: true });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to review vacation evidence.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    return NextResponse.json({ error: "vacation_evidence_review_failed", message, success: false }, { status: 400 });
  }
}
