import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { loadCandidateTimeline } from "@/lib/recruitment/candidate-timeline-loader";
import { getCandidateProfile } from "@/lib/recruitment/candidates";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One candidate's history, gathered from the five places that hold it.
 *
 * THE HISTORY WAS ALWAYS THERE AND WAS SHOWN NOWHERE TOGETHER. The status moves are in
 * `ats_candidate_status_events`, the sends in `ats_candidate_manager_sends`, the replies in
 * `ats_candidate_comments`, the CV read in `ats_cv_extractions`, and the arrival on the candidate
 * row beside its file. Answering "what has happened to this person" meant four screens, two of
 * which do not exist.
 *
 * ITS OWN ROUTE, not a field on the profile. The candidate route is on the hot path — the
 * workstation prefetches the NEXT candidate through it while you read the current one — and five
 * more queries on that path would be paid for every candidate, to render a tab most reviews never
 * open. This one is fetched when the tab is.
 *
 * Same gate as the profile it describes: `candidates: read`. Nothing here is more sensitive than
 * the CV itself, and nothing here is less.
 *
 * NOTHING IS INVENTED. `buildCandidateTimeline` emits a line only where a stored timestamp exists,
 * so a candidate whose record is thin gets a short timeline rather than a plausible one.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;
    await assertCandidateVisible(access, id);

    const profile = await getCandidateProfile(id);
    if (!profile) {
      return NextResponse.json({ error: "not_found", message: "Candidate not found.", success: false }, { status: 404 });
    }

    // The five reads and the wording live in one place, shared with the printed candidate record.
    const events = await loadCandidateTimeline(profile);

    return NextResponse.json({ events, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load this candidate's history.");
  }
}
