import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { createInterviewPollSet, listInterviewPollSets } from "@/lib/recruitment/interview-calendar-zoom-extras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Saved polls — written once, added to any Zoom interview. Editors and the owner.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const pollSets = await listInterviewPollSets(caller);
    return NextResponse.json({ pollSets, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the saved polls.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const body = await readJsonObject(request);
    const pollSets = await createInterviewPollSet(caller, { name: body.name, questions: body.questions });
    return NextResponse.json({ pollSets, success: true }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Could not save the poll.");
  }
}
