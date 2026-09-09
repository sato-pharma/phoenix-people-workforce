// Recruitment / ATS — reading the CV a manager still owes feedback on.
//
// The rule, the wording and what counts as feedback live in cv-feedback-lock.ts, which is pure. This
// file only asks the database the one question that rule needs: of the CVs this manager has opened
// since the lock shipped, which is the oldest he has not yet written about?
//
// 🔴 IT FAILS OPEN, ON EVERY ERROR, DELIBERATELY. A missing table, a slow read, a bad row — any of
// them return "he owes nothing" and the CV opens. The alternative is a manager locked out of every
// CV in the company by a transient database error, with a message telling him to go and comment on
// something he cannot reach. A lock that occasionally lets somebody through costs one missing note;
// a lock that occasionally jams costs the whole feature, because it gets switched off that morning.

import { canonicalHrIdForDisplay, canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import {
  FEEDBACK_REQUIRED_FROM,
  openIsUnderTheRule,
  type OutstandingFeedback,
} from "@/lib/recruitment/cv-feedback-lock";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { recruitmentDb } from "@/lib/recruitment/db";

/** How many recent opens to consider. A manager with more than this outstanding has bigger problems. */
const OPENS_SCANNED = 200;

function isMissingRelation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42P01" || code === "42703" || code === "PGRST205") return true;
  const message = String((error as { message?: string } | null)?.message ?? "");
  return /schema cache/i.test(message);
}

function textOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * The oldest CV this manager has opened under the rule and not yet written about, or null.
 *
 * OLDEST, not newest, on purpose. A manager who opens three CVs in a burst before the first block
 * lands should be sent back to the first one — that is the CV whose candidate is most likely to be
 * telephoned by somebody else while he says nothing, and it is also the order he would expect.
 */
export async function loadOutstandingFeedback(
  viewerHrId: string | null | undefined,
): Promise<OutstandingFeedback | null> {
  const viewer = canonicalHrIdForDisplay(viewerHrId);
  if (!viewer) return null;

  try {
    const keys = hrIdLookupKeys(viewerHrId);
    if (keys.length === 0) return null;

    // 1 · What he has opened since the lock shipped, oldest first.
    //
    // last_seen_at, NEVER first_seen_at. first_seen_at is the first time he EVER opened that CV, so a
    // manager reopening something he read last week would create no obligation at all and the lock
    // would silently do nothing — which is exactly what happened the first time this was tested
    // against a real session. What creates the duty is the open he just made, and that is last_seen_at.
    const { data: views, error: viewsError } = await recruitmentDb()
      .from("ats_candidate_views")
      .select("candidate_id,last_seen_at")
      .in("viewer_hr_id", keys)
      .gte("last_seen_at", FEEDBACK_REQUIRED_FROM)
      .order("last_seen_at", { ascending: true })
      .limit(OPENS_SCANNED);
    if (viewsError) throw viewsError;

    const opens = ((views ?? []) as Array<{ candidate_id: unknown; last_seen_at: unknown }>)
      .map((row) => ({ candidateId: String(row.candidate_id ?? ""), openedAt: String(row.last_seen_at ?? "") }))
      .filter((row) => row.candidateId && openIsUnderTheRule(row.openedAt));
    if (opens.length === 0) return null;

    const ids = Array.from(new Set(opens.map((row) => row.candidateId)));

    // 2 · Which of them he has already commented on. Chunked, because a PostgREST `.in()` carrying
    // several hundred ids comes back empty with no error.
    const commented = new Set<string>();
    for (const batch of chunkIds(ids, 50)) {
      const { data, error } = await recruitmentDb()
        .from("ats_candidate_comments")
        .select("candidate_id,author_hr_id")
        .in("candidate_id", batch);
      if (error) throw error;
      for (const row of (data ?? []) as Array<{ candidate_id: unknown; author_hr_id: unknown }>) {
        if (canonicalHrIdKey(String(row.author_hr_id ?? "")) === canonicalHrIdKey(viewer)) {
          commented.add(String(row.candidate_id ?? ""));
        }
      }
    }

    // 3 · And which he answered with a note — the reason Skip already requires. Also collects the
    // name, so the message can end "Start with Ahmed Hasan" rather than quote a uuid at him.
    const names = new Map<string, string | null>();
    const answeredWithNote = new Set<string>();
    for (const batch of chunkIds(ids, 50)) {
      const { data, error } = await recruitmentDb()
        .from("ats_candidates")
        .select("id,full_name,status_note,status_changed_by_hr_id")
        .in("id", batch);
      if (error) throw error;
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const id = String(row.id ?? "");
        names.set(id, textOrNull(row.full_name));
        const byHim = canonicalHrIdKey(String(row.status_changed_by_hr_id ?? "")) === canonicalHrIdKey(viewer);
        if (byHim && textOrNull(row.status_note)) answeredWithNote.add(id);
      }
    }

    for (const open of opens) {
      if (commented.has(open.candidateId) || answeredWithNote.has(open.candidateId)) continue;
      return {
        candidateId: open.candidateId,
        candidateName: names.get(open.candidateId) ?? null,
        openedAt: open.openedAt,
      };
    }
    return null;
  } catch (error) {
    // FAIL OPEN — see the header. Logged unless it is simply a table this database does not have yet.
    if (!isMissingRelation(error)) {
      logError("The CV feedback lock could not be evaluated; the open was allowed", {
        error,
        labels: { event: "cv_feedback_lock_read_failed", viewer },
      });
    }
    return null;
  }
}
