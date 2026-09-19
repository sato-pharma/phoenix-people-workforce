import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  CV_UPLOAD_LIMIT_BYTES,
  createInterviewBooking,
  interviewCalendarCaller,
  listInterviewCalendarDay,
  listInterviewCalendarWeek,
  listUpcomingInterviewsForCandidate,
  type InterviewCvUpload,
} from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  ?week=YYYY-MM-DD        the week's interviews and sessions (the calendar)
//      ?day=YYYY-MM-DD         one day's (the schedule dialog marks the taken times)
//      ?candidateId=<uuid>     one candidate's interviews from today on (shown before booking again)
// POST                         book one — JSON, or multipart with a `payload` JSON field and a `cv`
//                              file when someone from outside is booked with their CV
//
// Every branch passes the calendar's own gate, for the week it touches, inside the domain module —
// src/lib/recruitment/interview-calendar.ts. A copy link rides along as `?link=` or a header.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const params = new URL(request.url).searchParams;
    const candidateId = params.get("candidateId");
    const day = params.get("day");
    const headers = { "Cache-Control": "no-store" };

    if (candidateId) {
      const bookings = await listUpcomingInterviewsForCandidate(caller, candidateId);
      return NextResponse.json({ bookings, success: true }, { headers });
    }
    if (day) {
      return NextResponse.json({ success: true, ...(await listInterviewCalendarDay(caller, day)) }, { headers });
    }
    return NextResponse.json({ success: true, ...(await listInterviewCalendarWeek(caller, params.get("week") ?? "")) }, { headers });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the interview calendar.");
  }
}

async function readBookingRequest(request: Request): Promise<{ body: Record<string, unknown>; cv: InterviewCvUpload | null }> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("multipart/form-data")) return { body: await readJsonObject(request), cv: null };
  const form = await request.formData();
  const payload = form.get("payload");
  let body: Record<string, unknown> = {};
  try {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    throw new Error("The booking could not be read. Try again.");
  }
  const file = form.get("cv");
  if (!file || typeof file === "string") return { body, cv: null };
  // Refused before the bytes are read, so an oversized upload costs nothing more.
  if (file.size > CV_UPLOAD_LIMIT_BYTES) throw new Error("The CV is larger than 10 MB.");
  const bytes = Buffer.from(await file.arrayBuffer());
  return { body, cv: { bytes, fileName: file.name || "cv", mimeType: file.type || "", sizeBytes: file.size } };
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { body, cv } = await readBookingRequest(request);
    const result = await createInterviewBooking(
      caller,
      {
        addToRecruitment: body.addToRecruitment,
        candidateId: body.candidateId,
        dateKey: body.dateKey,
        durationMinutes: body.durationMinutes,
        external: body.external,
        interviewerHrId: body.interviewerHrId,
        notes: body.notes,
        platform: body.platform,
        sessionId: body.sessionId,
        startMinutes: body.startMinutes,
      },
      { cv },
    );
    return NextResponse.json({ success: true, ...result }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Could not book the interview.");
  }
}
