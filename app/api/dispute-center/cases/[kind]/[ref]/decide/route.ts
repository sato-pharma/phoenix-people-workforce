import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { decideDailyDispute } from "@/lib/dispute-center/daily.ts";
import { decideDeductionDispute, type DeductionDisputeOutcome } from "@/lib/dispute-center/deduction.ts";
import { decideDigestDispute } from "@/lib/dispute-center/digest.ts";
import { disputeCenterError } from "@/lib/dispute-center/http.ts";
import { isDisputeCaseKind } from "@/lib/dispute-center/types.ts";
import { validationError } from "@/lib/http/api-errors";
import { decidePrivateCalendarDataDispute } from "@/lib/private-calendar/disputes";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// THE DECISION. Each module decides its own thing, and the words differ because the things differ:
// a calendar dispute accepts or rejects a claim about a day, a deduction is accepted, rejected or
// REDUCED to fewer days, a weekly-review day is upheld or rejected. The money a revised decision
// owes back after a paid month is recommended into the next open payroll's Additions — never paid
// here, and never by rewriting a published month.
export async function POST(request: Request, context: { params: Promise<{ kind: string; ref: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { kind, ref } = await context.params;
    if (!isDisputeCaseKind(kind)) throw validationError("That kind of dispute does not exist.");
    const caseRef = decodeURIComponent(ref);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const note = String(body.note ?? "");

    if (kind === "calendar") {
      const decision = String(body.outcome ?? "");
      if (decision !== "accept" && decision !== "reject") {
        throw validationError("Choose whether the claim is accepted or rejected.");
      }
      const dispute = await decidePrivateCalendarDataDispute(access, { decision, disputeId: caseRef, note });
      return NextResponse.json({ dispute, success: true });
    }

    if (kind === "daily") {
      // A released daily line is accepted (withdrawn, and its days never charged) or rejected (it stands).
      const outcome = String(body.outcome ?? "");
      if (outcome !== "accept" && outcome !== "reject") throw validationError("Choose accept or reject.");
      const result = await decideDailyDispute(access, { disputeId: caseRef, note, outcome });
      return NextResponse.json({ result, success: true });
    }

    if (kind === "deduction") {
      const outcome = String(body.outcome ?? "");
      if (outcome !== "accept" && outcome !== "reject" && outcome !== "reduce") {
        throw validationError("Choose accept, reject, or reduce.");
      }
      const result = await decideDeductionDispute(access, {
        candidateId: caseRef,
        note,
        outcome: outcome as DeductionDisputeOutcome,
        reducedValue: body.reducedValue == null ? null : Number(body.reducedValue),
      });
      return NextResponse.json({ result, success: true });
    }

    const outcome = String(body.outcome ?? "");
    if (outcome !== "uphold" && outcome !== "reject") throw validationError("Choose whether the dispute is upheld or rejected.");
    const result = await decideDigestDispute(access, { lineId: Number(caseRef), note, uphold: outcome === "uphold" });
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return disputeCenterError(error, "Unable to save this decision.");
  }
}
