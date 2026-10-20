import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertInterviewBookingVisible } from "@/lib/recruitment/workspace/fence";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import {
  emailInterviewInvitation,
  getInterviewInvitationPlan,
  recordInterviewWhatsAppOpened,
} from "@/lib/recruitment/interview-invitations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// One interview's invitations.
//   GET   who can be reached and on what, the messages ready to send, and what has been sent so far
//   POST  { channel: "email", recipient, kind }      e-mail it from Phoenix
//         { channel: "whatsapp", recipient, kind }   log that the WhatsApp chat was opened — the person
//                                                    presses Send in WhatsApp, so it is never "sent"
//
// Both need the calendar's "book" level (the owner and editors); the domain module enforces it.
export async function GET(request: Request, { params }: Context) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const plan = await getInterviewInvitationPlan(caller, id);
    return NextResponse.json({ plan, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the invitation.");
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const body = await readJsonObject(request);
    const input = { kind: body.kind, recipient: body.recipient };
    if (body.channel === "email") {
      const result = await emailInterviewInvitation(caller, id, input);
      return NextResponse.json({ success: result.status === "sent", ...result });
    }
    if (body.channel === "whatsapp") {
      const log = await recordInterviewWhatsAppOpened(caller, id, input);
      return NextResponse.json({ log, success: true });
    }
    throw new Error("Choose WhatsApp or e-mail.");
  } catch (error) {
    return recruitmentApiError(error, "Could not send the invitation.");
  }
}
