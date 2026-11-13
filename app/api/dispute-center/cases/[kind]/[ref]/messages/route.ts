import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { addDeductionsComment, addDeductionsReply } from "@/lib/deductions/comments.ts";
import { addDailyDisputeMessage } from "@/lib/dispute-center/daily.ts";
import { addDigestDisputeMessage } from "@/lib/dispute-center/digest.ts";
import { disputeCenterError, readDisputeMessageRequest } from "@/lib/dispute-center/http.ts";
import { resolveCaseParticipant } from "@/lib/dispute-center/participants.ts";
import { isDisputeCaseKind } from "@/lib/dispute-center/types.ts";
import { validationError } from "@/lib/http/api-errors";
import { addPrivateCalendarDisputeMessage } from "@/lib/private-calendar/dispute-messages";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A reply from either side, with up to four pictures (owner, 2026-10-09: "upload a picture in both").
// JSON for text, multipart when it carries pictures; every picture is checked by its own bytes before
// anything is written. Each module keeps its own thread table and its own notification rule — this
// route only decides which one the case belongs to.
export async function POST(request: Request, context: { params: Promise<{ kind: string; ref: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { kind, ref } = await context.params;
    if (!isDisputeCaseKind(kind)) throw validationError("That kind of dispute does not exist.");
    const caseRef = decodeURIComponent(ref);
    const { body, images } = await readDisputeMessageRequest(request);

    if (kind === "calendar") {
      const message = await addPrivateCalendarDisputeMessage(access, { body, disputeId: caseRef, images });
      return NextResponse.json({ message, success: true });
    }
    if (kind === "daily") {
      const message = await addDailyDisputeMessage(access, { body, disputeId: caseRef, images });
      return NextResponse.json({ message, success: true });
    }
    if (kind === "digest") {
      const message = await addDigestDisputeMessage(access, { body, images, lineId: Number(caseRef) });
      return NextResponse.json({ message, success: true });
    }

    // A deduction thread has two write paths with different gates and different notifications — the
    // employee's comment goes to HR, the reviewer's reply goes to the employee and their managers.
    // Which one this is follows from who is asking, not from anything the caller sends.
    const participant = await resolveCaseParticipant(access, "deduction", caseRef);
    const message =
      participant.isReviewer && !participant.isOwner
        ? (await addDeductionsReply({ access, body, candidateId: caseRef, images })).comment
        : await addDeductionsComment({ access, body, candidateId: caseRef, images });
    return NextResponse.json({ message, success: true });
  } catch (error) {
    return disputeCenterError(error, "Unable to send this reply.");
  }
}
