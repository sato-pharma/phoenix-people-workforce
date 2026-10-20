import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertInterviewBookingVisible } from "@/lib/recruitment/workspace/fence";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { addInterviewPoll, listInterviewPolls } from "@/lib/recruitment/interview-calendar-zoom-extras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// The polls on an interview's Zoom meeting (a slot's are its session's): listed for anyone who can
// see it; added by Editors and the owner — from a saved poll or typed for this interview.
export async function GET(request: Request, { params }: Context) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const polls = await listInterviewPolls(caller, { id, kind: "booking" });
    return NextResponse.json({ polls, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the polls.");
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
    const polls = await addInterviewPoll(caller, { id, kind: "booking" }, { pollSetId: body.pollSetId, questions: body.questions, title: body.title });
    return NextResponse.json({ polls, success: true }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Could not add the poll.");
  }
}
