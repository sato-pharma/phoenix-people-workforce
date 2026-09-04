import { NextResponse } from "next/server";

import { buildCandidateTimeline } from "@/lib/recruitment/candidate-timeline";
import { getCandidateProfile, listCandidateStatusEvents } from "@/lib/recruitment/candidates";
import { getLatestCvExtraction } from "@/lib/recruitment/cv-extraction";
import { listCandidateComments } from "@/lib/recruitment/candidate-comments";
import { listSendsForCandidate } from "@/lib/recruitment/manager-sends";
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
    await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;

    const profile = await getCandidateProfile(id);
    if (!profile) {
      return NextResponse.json({ error: "not_found", message: "Candidate not found.", success: false }, { status: 404 });
    }

    // Fired together: four independent reads, and awaiting them in sequence is four round trips for
    // a panel the reader is already looking at. Each falls back to empty rather than failing the
    // whole tab — a timeline missing its comments is still a timeline.
    const [statusEvents, sends, comments, extraction] = await Promise.all([
      listCandidateStatusEvents(id).catch(() => []),
      listSendsForCandidate(id).catch(() => []),
      listCandidateComments(id).catch(() => []),
      getLatestCvExtraction(id).catch(() => null),
    ]);

    const events = buildCandidateTimeline({
      comments,
      createdAt: profile.candidate.createdAt,
      extractions: extraction
        ? [{ createdAt: extraction.createdAt, extractionId: extraction.extractionId, isCv: extraction.isCv }]
        : [],
      files: profile.files.map((file) => ({
        createdAt: file.createdAt,
        fileName: file.fileName,
        id: file.id,
        kind: file.kind,
      })),
      interviews: profile.interviews.map(({ interview }) => ({
        createdAt: interview.createdAt,
        id: interview.id,
        interviewType: interview.interviewType,
        outcome: interview.outcome,
        scheduledAt: interview.scheduledAt,
      })),
      sends: sends.map((send) => ({
        managerName: send.managerName,
        position: send.position,
        sentAt: send.sentAt,
      })),
      source: profile.candidate.source,
      statusEvents,
    });

    return NextResponse.json({ events, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load this candidate's history.");
  }
}
