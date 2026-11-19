import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { resolveAccessContext } from "@/lib/auth/server";
import { decideCalendarReopen, requestCalendarReopen } from "@/lib/dispute-center/calendar.ts";
import { decideDailyReopen, requestDailyReopen } from "@/lib/dispute-center/daily.ts";
import { decideDeductionReopen, requestDeductionReopen } from "@/lib/dispute-center/deduction.ts";
import { decideDigestReopen, requestDigestReopen } from "@/lib/dispute-center/digest.ts";
import { disputeCenterError } from "@/lib/dispute-center/http.ts";
import { isDisputeCaseKind } from "@/lib/dispute-center/types.ts";
import { validationError } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The employee's "ask to reopen" sends `{ action: "request", note }`; the reviewer's answer sends
 * `{ action: "grant" | "decline", note }`. `reason` is the older name for the note and is still read
 * when `note` is absent. The action is checked below with the route's own words, and each adapter
 * refuses the half that is not the caller's, so every field is optional here.
 */
const ReopenBodySchema = z.object({
  action: z.string().nullish(),
  note: z.string().nullish(),
  reason: z.string().nullish(),
});

// "Employee asks, reviewer reopens" (owner, 2026-10-09). Two actions on one route because they are
// two halves of one rule: `action: "request"` is the employee asking, `"grant"` and `"decline"` are
// the reviewer answering. Each adapter refuses the half that is not the caller's.
export async function POST(request: Request, context: { params: Promise<{ kind: string; ref: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    // REC-080: a signed-out caller is refused before the path's kind is judged.
    assertSignedIn(access);
    const { kind, ref } = await context.params;
    if (!isDisputeCaseKind(kind)) throw validationError("That kind of dispute does not exist.");
    const caseRef = decodeURIComponent(ref);
    const parsed = await parseJsonBody(request, ReopenBodySchema, { fallback: {} });
    if (!parsed.ok) throw validationError(parsed.message);
    const body = parsed.data;
    const action = String(body.action ?? "");
    const note = String(body.note ?? body.reason ?? "");
    if (action !== "request" && action !== "grant" && action !== "decline") {
      throw validationError("Say whether this is a request to reopen, or a reviewer's answer to one.");
    }

    if (action === "request") {
      if (kind === "calendar") await requestCalendarReopen(access, { disputeId: caseRef, reason: note });
      else if (kind === "deduction") await requestDeductionReopen(access, { candidateId: caseRef, reason: note });
      else if (kind === "daily") await requestDailyReopen(access, { disputeId: caseRef, reason: note });
      else await requestDigestReopen(access, { lineId: Number(caseRef), reason: note });
      return NextResponse.json({ success: true });
    }

    const grant = action === "grant";
    if (kind === "calendar") await decideCalendarReopen(access, { disputeId: caseRef, grant, note });
    else if (kind === "deduction") await decideDeductionReopen(access, { candidateId: caseRef, grant, note });
    else if (kind === "daily") await decideDailyReopen(access, { disputeId: caseRef, grant, note });
    else await decideDigestReopen(access, { grant, lineId: Number(caseRef), note });
    return NextResponse.json({ success: true });
  } catch (error) {
    return disputeCenterError(error, "Unable to save this.");
  }
}
