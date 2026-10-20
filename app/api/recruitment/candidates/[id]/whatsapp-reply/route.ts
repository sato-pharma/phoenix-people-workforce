import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { sendWhatsAppText } from "@/lib/recruitment/inbound/whatsapp-interactive";
import { resolveCandidateReplyTarget } from "@/lib/recruitment/inbound/whatsapp-conversation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Meta's own limit on a text message body. Refused here so the recruiter is told, not Meta. */
const MAX_REPLY_LENGTH = 4096;

/**
 * Can this candidate be answered, and from which line?
 *
 * The box is not drawn until this says yes, because the alternative is a recruiter typing a
 * paragraph into a field that was never going to send it. Gated identically to the POST rather than
 * on candidates:read — only someone who may send needs to know whether sending is possible, and a
 * reply window is a fact about a conversation with a member of the public.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    await assertCandidateVisible(access, id);
    const target = await resolveCandidateReplyTarget(id);
    if (!target) {
      return NextResponse.json({ canReply: false, reason: "no_conversation" });
    }
    return NextResponse.json({
      canReply: target.windowOpen,
      lastInboundAt: target.lastInboundAt,
      lineNumber: target.lineNumber,
      minutesLeft: target.minutesLeft,
      reason: target.windowOpen ? null : "window_closed",
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to check the WhatsApp reply window.");
  }
}

/**
 * Answer an applicant on WhatsApp, in a recruiter's own words, from inside Phoenix.
 *
 * Until now the only "send" in this codebase PREPARED a wa.me link for a human to press in their
 * own WhatsApp. That was the honest design while no line was ours to send from. Since the HR
 * handset joined the platform on 2026-09-11 the company owns both lines, so a reply can leave from
 * the number the applicant actually wrote to, and be recorded.
 *
 * The gate is `recruitment: update`, matching the template send — messaging an applicant in the
 * company's name is acting on the pipeline, and is deliberately the same authority as sending their
 * CV to a manager rather than a new one.
 *
 * TWO REFUSALS, both of which exist to tell a human something Meta would otherwise say obscurely:
 *
 *   404 — this candidate has never written to us on WhatsApp. There is no conversation to answer
 *         and no line to answer from. Replying anyway would message them from a number they have
 *         never seen.
 *   409 — the 24-hour free-form window has closed. Meta refuses this with an error code that
 *         reaches the UI as a generic failure, so it is caught before the send rather than after.
 *
 * Nothing here retries. A reply is a person's sentence, and a duplicate of it is worse than a
 * failure they can see and repeat deliberately.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    await assertCandidateVisible(access, id);

    const body = await readJsonObject(request);
    const text = str(body.text)?.trim() ?? "";
    if (!text) {
      return recruitmentProblem("Write something before sending.", 400);
    }
    if (text.length > MAX_REPLY_LENGTH) {
      return recruitmentProblem(`That is too long for one WhatsApp message. The limit is ${MAX_REPLY_LENGTH} characters.`, 400);
    }

    const target = await resolveCandidateReplyTarget(id);
    if (!target) {
      return recruitmentProblem(
        "This candidate has never messaged us on WhatsApp, so there is no conversation to reply to.",
        404,
      );
    }
    if (!target.windowOpen) {
      return recruitmentProblem(
        "WhatsApp only allows a written reply within 24 hours of their last message, and that has passed. Send an approved template instead.",
        409,
      );
    }

    const result = await sendWhatsAppText({
      event: "whatsapp_manual_reply_send",
      logContext: { detail: { candidateId: id, sentByHrId: access.hrId ?? null } },
      phoneNumberId: target.phoneNumberId,
      text,
      toWaId: target.toWaId,
    });

    if (!result.ok) {
      // `window_closed` can still come back despite the check above: the boundary can pass between
      // the read and the send. Reported as the same refusal a human already understands rather than
      // as an unexplained failure.
      if (result.reason === "window_closed") {
        return recruitmentProblem(
          "WhatsApp closed the 24-hour reply window while this was being sent. Send an approved template instead.",
          409,
        );
      }
      return recruitmentProblem("WhatsApp did not accept that message. It has not been sent.", 502, {
        reason: result.reason,
      });
    }

    return NextResponse.json({
      sentFrom: target.lineNumber,
      success: true,
      wamid: result.wamid,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to send the WhatsApp reply.");
  }
}
