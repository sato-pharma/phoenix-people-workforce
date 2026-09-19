// Recruitment / ATS — everything a printed candidate record needs, read in one place.
//
// SERVER ONLY. Reaches the database. The page under /print/candidate-record calls it, so the paper and
// the screen (app/(admin)/recruitment/candidate/[id]) read a candidate through the same loader and can
// never describe two different people.
//
// THREE READS, EACH ALLOWED TO FAIL ON ITS OWN. The record is `loadCandidateRecord` — the very loader
// the screen uses, which already reports which of its own parts it could not read. The history is the
// timeline route's own body (candidate-timeline-loader.ts), and the notes are read here. A failed
// history or a failed notes read becomes NULL, and the sheet then says "Could not load …" in that
// section. A section that quietly printed as empty would read as "nothing has happened", which is a
// claim about a person the system never made.
//
// The notes are read a second time inside the timeline (a note is an event in the history too). One
// extra small query on a page nobody opens in bulk is cheaper than two loaders that disagree about how a
// failure is reported.

import { listCandidateComments } from "@/lib/recruitment/candidate-comments";
import { loadCandidateRecord } from "@/lib/recruitment/candidate-record";
import { buildCandidateRecordPrint, type CandidateRecordPrint } from "@/lib/recruitment/candidate-record-print";
import { loadCandidateTimeline } from "@/lib/recruitment/candidate-timeline-loader";

/** The record as a printable model. Null when there is no such candidate. */
export async function loadCandidateRecordPrint(candidateId: string, now: Date = new Date()): Promise<CandidateRecordPrint | null> {
  const record = await loadCandidateRecord(candidateId);
  if (!record) return null;

  const [timeline, notes] = await Promise.all([
    loadCandidateTimeline(record.profile).catch(() => null),
    listCandidateComments(candidateId).catch(() => null),
  ]);

  return buildCandidateRecordPrint({ notes, now, record, timeline });
}
