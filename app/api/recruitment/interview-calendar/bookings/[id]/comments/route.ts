import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { addInterviewComment } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A note on an interview — Commenter, Editor or the owner. Returns the interview with its notes.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const { id } = await params;
    const body = await readJsonObject(request);
    const booking = await addInterviewComment(access, id, body.body);
    return NextResponse.json({ booking, success: true }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Could not save the note.");
  }
}
