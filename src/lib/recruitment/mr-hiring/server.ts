// Recruitment / Medical Rep hiring — the three reads the screens make.
//
// SERVER ONLY. Each read is gated here before anything is loaded or returned:
//   * the board — the HR Manager, Talent Acquisition and the CEO (the read-all seats);
//   * one candidate's journey (§10) — the read-all seats and everyone involved (access.ts);
//   * a manager's own Medical Rep interviews — only the interviews that person is on.
// The Talent Acquisition fence is asked by the page or route that hands the rows on (the fence's own
// test walks those files), never inside these readers.

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { forbiddenError, notFoundError } from "@/lib/http/api-errors";
import { listCandidateStatusEvents } from "@/lib/recruitment/candidates";
import type { CandidateTimelineEvent } from "@/lib/recruitment/candidate-timeline";
import { listSendsForCandidate } from "@/lib/recruitment/manager-sends";
import { isOnBooking, mayReadMrJourney, mrViewer, redactFactsFor } from "@/lib/recruitment/mr-hiring/access";
import { loadMrCandidate, loadMrCandidates, mrCandidateIdsInterviewedBy, type MrCandidateRecord } from "@/lib/recruitment/mr-hiring/facts-db";
import { buildMrJourneyTimeline } from "@/lib/recruitment/mr-hiring/journey";
import { buildMrRow, type MrInterviewRow, type MrRow } from "@/lib/recruitment/mr-hiring/rows";

/** Every Medical Rep candidate, for the read-all seats. Refuses anyone else. */
export async function loadMrBoardRecords(access: AccessContext): Promise<MrCandidateRecord[]> {
  if (!mrViewer(access).readsAll) throw forbiddenError("The Medical Rep hiring page is for the HR Manager, Talent Acquisition and the CEO.");
  return loadMrCandidates();
}

/** The rows for records the caller already loaded (and fenced). */
export function mrRowsFor(access: AccessContext, records: readonly MrCandidateRecord[], now: Date = new Date()): MrRow[] {
  const viewer = mrViewer(access);
  return records.map((record) => buildMrRow(viewer, record, now));
}

export type MrJourney = { row: MrRow; timeline: CandidateTimelineEvent[] };

/** One candidate's whole journey (§10), salary removed for anyone who may not see it. */
export async function loadMrJourney(access: AccessContext, candidateId: string): Promise<MrJourney> {
  const record = await loadMrCandidate(candidateId);
  if (!record) throw notFoundError("This candidate is not in the Medical Rep hiring list.");
  // Someone not involved is told the candidate is not there, never that a candidate exists.
  if (!(await mayReadMrJourney(access, record))) throw notFoundError("This candidate is not in the Medical Rep hiring list.");
  const viewer = mrViewer(access);
  const [statusEvents, sends] = await Promise.all([
    listCandidateStatusEvents(candidateId).catch(() => []),
    listSendsForCandidate(candidateId).catch(() => []),
  ]);
  const timeline = buildMrJourneyTimeline(
    { ...record, facts: redactFactsFor(viewer, record.facts) },
    { sends: sends.map((send) => ({ managerName: send.managerName, position: send.position, sentAt: send.sentAt })), statusEvents },
  );
  return { row: buildMrRow(viewer, record), timeline };
}

/** The Medical Rep interviews this person is on — the manager portal's "My Medical Rep interviews". */
export async function loadMyMrInterviews(access: AccessContext, now: Date = new Date()): Promise<MrInterviewRow[]> {
  const viewer = mrViewer(access);
  if (!viewer.hrIdKey) return [];
  const ids = await mrCandidateIdsInterviewedBy(hrIdLookupKeys(access.hrId));
  if (ids.length === 0) return [];
  const records = await loadMrCandidates({ candidateIds: ids });
  const rows: MrInterviewRow[] = [];
  for (const record of records) {
    const mine = record.facts.bookings
      .filter((booking) => booking.round !== null && isOnBooking(viewer, booking))
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
    if (mine.length === 0) continue;
    rows.push({ ...buildMrRow(viewer, record, now), mine });
  }
  // The newest interview first — the one a manager is about to hold or has just held.
  return rows.sort((left, right) => (right.mine.at(-1)?.startsAt ?? "").localeCompare(left.mine.at(-1)?.startsAt ?? ""));
}
