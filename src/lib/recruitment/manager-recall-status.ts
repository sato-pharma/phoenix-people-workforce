// Recruitment / ATS — the status move at the end of taking a CV back from a manager.
//
// A recall deletes the manager's send, puts the legacy stamp right, and then a CV nobody holds any more
// goes from `sent_to_manager` back to `shortlisted`. That last step used to go through
// updateCandidateStatus, which exists for a person's click and refuses exactly that transition
// (statusChangeRefusal): the refusal protects a CV a manager STILL holds, and here he no longer does.
// So on 2026-10-17 the recall of nine CVs from one manager deleted all nine sends, cleared the stamps,
// then threw on the status step and left every CV at `sent_to_manager` with nobody holding it.
//
// This writes straight to the table, exactly as manager-hold-return.ts's returnOne does for the 45-day
// return, and never asks the guard. The client is a parameter so the write can be tested without a
// database.

import { logError } from "@/lib/observability/log";

/** The part of a Supabase client this write needs. */
export type StatusWriteClient = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export const RECALL_RETURN_STATUS = "shortlisted";

/**
 * Move one CV from `sent_to_manager` back to `shortlisted` after its last send was deleted.
 *
 * Conditional on it STILL being `sent_to_manager`, so a recruiter who moved it a moment ago is never
 * overwritten. Returns false when somebody got there first. The history line is best effort: the status
 * has already changed, and reporting a completed recall as a failure would only invite a second press.
 */
export async function returnReleasedCvToShortlist(
  supabase: StatusWriteClient,
  input: { actorHrId: string | null; candidateId: string; changedAt: string; note: string },
): Promise<boolean> {
  const { data, error } = await supabase
    .from("ats_candidates")
    .update({
      status: RECALL_RETURN_STATUS,
      status_changed_at: input.changedAt,
      status_changed_by_hr_id: input.actorHrId,
      status_note: input.note,
      updated_at: input.changedAt,
    })
    .eq("id", input.candidateId)
    .eq("status", "sent_to_manager")
    .select("id");
  if (error) throw error;
  if (((data as unknown[] | null) ?? []).length === 0) return false;

  const event = await supabase.from("ats_candidate_status_events").insert({
    actor_hr_id: input.actorHrId,
    candidate_id: input.candidateId,
    from_status: "sent_to_manager",
    note: input.note,
    to_status: RECALL_RETURN_STATUS,
  });
  if (event.error) {
    logError("A CV was taken back from its manager but the history line could not be written", {
      error: event.error,
      labels: { candidate_id: input.candidateId, event: "manager_recall_event_write_failed" },
    });
  }
  return true;
}
