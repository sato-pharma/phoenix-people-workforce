import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { deleteInterviewPollSet, updateInterviewPollSet } from "@/lib/recruitment/interview-calendar-zoom-extras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// Change or delete a saved poll. Polls already added to an interview keep their own copy.
export async function PATCH(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const body = await readJsonObject(request);
    const pollSets = await updateInterviewPollSet(caller, id, { name: body.name, questions: body.questions });
    return NextResponse.json({ pollSets, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not save the poll.");
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const pollSets = await deleteInterviewPollSet(caller, id);
    return NextResponse.json({ pollSets, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not delete the poll.");
  }
}
