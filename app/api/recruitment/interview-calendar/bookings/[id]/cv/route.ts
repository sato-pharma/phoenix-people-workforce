import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import { getInterviewExternalCv, interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";

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
    return recruitmentFileResponse(request, await getInterviewExternalCv(caller, id));
  } catch (error) {
    return recruitmentApiError(error, "Could not open the CV.");
  }
}
