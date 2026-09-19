// Recruitment / ATS — one candidate's history, read from the five places that hold it.
//
// SERVER ONLY. Reaches the database. It is the body of the timeline route
// (app/api/recruitment/candidates/[id]/timeline/route.ts), lifted out so the printed candidate record
// (candidate-record-print-loader.ts) reads the SAME history in the SAME way. Two copies of "which reads
// feed the timeline" would drift, and the printed history would then disagree with the screen's.
//
// Each of the four side reads falls back to empty rather than failing: a timeline missing its comments
// is still a timeline. Nothing here invents an event; `buildCandidateTimeline` only emits a line where
// a stored timestamp exists.

import { listCandidateComments } from "@/lib/recruitment/candidate-comments";
import { buildCandidateTimeline, type CandidateTimelineEvent } from "@/lib/recruitment/candidate-timeline";
import { listCandidateStatusEvents, type CandidateProfile } from "@/lib/recruitment/candidates";
import { getLatestCvExtraction } from "@/lib/recruitment/cv-extraction";
import { listSendsForCandidate } from "@/lib/recruitment/manager-sends";

export async function loadCandidateTimeline(profile: CandidateProfile): Promise<CandidateTimelineEvent[]> {
  const id = profile.candidate.id;

  // Fired together: four independent reads, and awaiting them in sequence is four round trips.
  const [statusEvents, sends, comments, extraction] = await Promise.all([
    listCandidateStatusEvents(id).catch(() => []),
    listSendsForCandidate(id).catch(() => []),
    listCandidateComments(id).catch(() => []),
    getLatestCvExtraction(id).catch(() => null),
  ]);

  return buildCandidateTimeline({
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
}
