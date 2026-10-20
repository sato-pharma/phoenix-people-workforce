import { NextResponse } from "next/server";
import { fenceCandidateIds } from "@/lib/recruitment/workspace/fence";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller, searchInterviewCandidates } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Recruitment's candidates by name, phone or e-mail — for booking from an empty cell. Needs the right
// to book AND Recruitment's own read grant: sharing the calendar is not a key to every applicant.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const found = await searchInterviewCandidates(caller, new URL(request.url).searchParams.get("q"));
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is never offered to her.
    const visible = await fenceCandidateIds(access, found.map((candidate) => candidate.id));
    const candidates = found.filter((candidate) => visible.has(candidate.id));
    return NextResponse.json({ candidates, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not search the candidates.");
  }
}
