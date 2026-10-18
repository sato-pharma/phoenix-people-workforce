// Recruitment / ATS — the status move at the end of taking a CV back from a manager.
//
// A recall deletes the manager's send, puts the legacy stamp right, and then a CV nobody holds any more
// goes from `sent_to_manager` back to `shortlisted`. That last step used to go through
// updateCandidateStatus, which exists for a person's click and refuses exactly that transition
// (statusChangeRefusal): the refusal protects a CV a manager STILL holds, and here he no longer does.
// So on 2026-10-17 the recall of nine CVs from one manager deleted all nine sends, cleared the stamps,
// then threw on the status step and left every CV at `sent_to_manager` with nobody holding it.
//
// This writes straight to the table and never asks the guard. It is the ONE write for both ways a CV
// nobody holds comes back: a person's recall (below) and manager-hold-return.ts's 45-day sweep, which
// calls the same function under an `ops:` actor. The client is a parameter so the write can be tested
// without a database.

import { logError } from "@/lib/observability/log";

/** The part of a Supabase client this write needs. */
export type StatusWriteClient = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export const RECALL_RETURN_STATUS = "shortlisted";

/**
 * Is this history line the move written here — a CV coming back from a manager? It is signed by the person
 * who took it back, yet it is nobody's verdict on the candidate, so a reader looking for a decision skips
 * it through this and never through its own copy of the pair. A person's own click cannot make the move
 * (statusChangeRefusal), so every such line is a return.
 */
export function isSentCvReturn(event: { fromStatus?: string | null; toStatus: string }): boolean {
  return event.fromStatus === "sent_to_manager" && event.toStatus === RECALL_RETURN_STATUS;
}

export type SentCvReturn = {
  candidateId: string;
  changedAt: string;
  note: string;
  /** Stamped on the CV: the person who took it back, or null for a sweep. */
  statusActorHrId: string | null;
  /** Named on the history line: the person, or an `ops:` actor so reports never count a sweep as a decision. */
  eventActorHrId: string | null;
  /** The log line, should the history line not be written. */
  eventWriteFailed: { event: string; message: string };
};

/**
 * Move one CV from `sent_to_manager` back to `shortlisted` after its last send is gone.
 *
 * Conditional on it STILL being `sent_to_manager`, so a recruiter or a manager who answered a moment ago
 * is never overwritten. Returns false when somebody got there first. The history line is best effort:
 * the status has already changed, and reporting a completed return as a failure would only invite a
 * second press, or a second run to look for it again.
 */
export async function returnSentCvToShortlist(supabase: StatusWriteClient, input: SentCvReturn): Promise<boolean> {
  const { data, error } = await supabase
    .from("ats_candidates")
    .update({
      status: RECALL_RETURN_STATUS,
      status_changed_at: input.changedAt,
      status_changed_by_hr_id: input.statusActorHrId,
      status_note: input.note,
      updated_at: input.changedAt,
    })
    .eq("id", input.candidateId)
    .eq("status", "sent_to_manager")
    .select("id");
  if (error) throw error;
  if (((data as unknown[] | null) ?? []).length === 0) return false;

  const event = await supabase.from("ats_candidate_status_events").insert({
    actor_hr_id: input.eventActorHrId,
    candidate_id: input.candidateId,
    from_status: "sent_to_manager",
    note: input.note,
    to_status: RECALL_RETURN_STATUS,
  });
  if (event.error) {
    logError(input.eventWriteFailed.message, {
      error: event.error,
      labels: { candidate_id: input.candidateId, event: input.eventWriteFailed.event },
    });
  }
  return true;
}

/** A person took the CV back: the card and the history line both name them. */
export function returnReleasedCvToShortlist(
  supabase: StatusWriteClient,
  input: { actorHrId: string | null; candidateId: string; changedAt: string; note: string },
): Promise<boolean> {
  return returnSentCvToShortlist(supabase, {
    candidateId: input.candidateId,
    changedAt: input.changedAt,
    note: input.note,
    statusActorHrId: input.actorHrId,
    eventActorHrId: input.actorHrId,
    eventWriteFailed: {
      event: "manager_recall_event_write_failed",
      message: "A CV was taken back from its manager but the history line could not be written",
    },
  });
}
