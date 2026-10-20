import { NextResponse } from "next/server";
import { assertApplicationVisible } from "@/lib/recruitment/workspace/fence";

import { isOfferResponse } from "@/lib/recruitment/offer-rules";
import {
  decideOfferApproval,
  getOffer,
  markOfferSent,
  recordOfferResponse,
  saveOfferDraft,
  submitOfferForApproval,
} from "@/lib/recruitment/offers";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's application answers as if absent.
    await assertApplicationVisible(access, id);
    const offer = await getOffer(id);
    return NextResponse.json({ success: true, offer });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the offer.");
  }
}

/**
 * One route, one `intent` — the offer's five steps all act on the same row and all need the same
 * permission, so five sibling routes would only spread the same three lines of preamble.
 *
 * Who may do what is NOT decided here: every branch runs assertRecruitmentTransition inside the
 * service, and the workflow registry is what restricts approval to a Super Admin.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's application answers as if absent.
    await assertApplicationVisible(access, id);
    const body = await readJsonObject(request);
    const intent = str(body.intent);
    const reason = str(body.reason);

    switch (intent) {
      case "save_draft": {
        const result = await saveOfferDraft(id, access, {
          jobTitle: str(body.jobTitle),
          // Left as-is rather than num()'d: the service normalises it, and num() would turn a
          // typo like "12,000" into null silently instead of rejecting the salary.
          monthlyGross: typeof body.monthlyGross === "string" || typeof body.monthlyGross === "number" ? body.monthlyGross : null,
          startDate: str(body.startDate),
          notes: str(body.notes),
        });
        return NextResponse.json({ success: true, ...result });
      }
      case "submit_approval": {
        const result = await submitOfferForApproval(id, access);
        return NextResponse.json({ success: true, ...result });
      }
      case "approve": {
        const result = await decideOfferApproval(id, access, { approved: true });
        return NextResponse.json({ success: true, ...result });
      }
      case "reject_approval": {
        const result = await decideOfferApproval(id, access, { approved: false, reason });
        return NextResponse.json({ success: true, ...result });
      }
      case "mark_sent": {
        const result = await markOfferSent(id, access);
        return NextResponse.json({ success: true, ...result });
      }
      case "record_response": {
        const response = body.response;
        if (!isOfferResponse(response)) {
          return NextResponse.json(
            {
              error: "invalid_request",
              message: "The candidate's answer must be accepted, declined, or expired.",
              success: false,
            },
            { status: 400 },
          );
        }
        const result = await recordOfferResponse(id, access, { response, reason });
        return NextResponse.json({ success: true, ...result });
      }
      default:
        return NextResponse.json(
          { error: "invalid_request", message: "An offer intent is required.", success: false },
          { status: 400 },
        );
    }
  } catch (error) {
    return recruitmentApiError(error, "Failed to update the offer.");
  }
}
