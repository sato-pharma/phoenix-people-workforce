import { NextResponse } from "next/server";
import { assertInterviewBookingVisible } from "@/lib/recruitment/workspace/fence";

import { assertSameOriginMutation, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import {
  CV_UPLOAD_LIMIT_BYTES,
  getInterviewExternalCv,
  interviewCalendarCaller,
  replaceInterviewExternalCv,
} from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The CV of someone from outside Phoenix, kept on their booking alone (they were not added to
// Recruitment). For anyone who can see that week — a link holder not signed in, only when the owner
// left the link's CVs on.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's CV answers as if absent.
    await assertInterviewBookingVisible(access, id);
    return recruitmentFileResponse(request, await getInterviewExternalCv(caller, id));
  } catch (error) {
    return recruitmentApiError(error, "Could not open the CV.");
  }
}

// Replace (or attach) the CV on an OUTSIDE candidate's interview — a `cv` file in multipart form data
// (owner, 2026-09-26, Tier 3: edit the CV, e.g. one added after booking). Needs book-level access;
// refused for an in-house candidate, whose CV lives on their Recruitment record.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const form = await request.formData();
    const file = form.get("cv");
    if (!file || typeof file === "string") throw new Error("Choose a CV file to upload.");
    if (file.size > CV_UPLOAD_LIMIT_BYTES) throw new Error("The CV is larger than 10 MB.");
    const bytes = Buffer.from(await file.arrayBuffer());
    const booking = await replaceInterviewExternalCv(caller, id, { bytes, fileName: file.name || "cv", mimeType: file.type || "" });
    return NextResponse.json({ booking, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not update the CV.");
  }
}
