// Recruitment / ATS — a manager reading the CVs of the managers beneath them.
//
// The owner, 2026-08-30: *"I want the National Sales Manager to have the authority to filter for one
// of the district managers reporting to him and see the CVs and candidates in his portal ... and can
// also give a comment on the CV itself."*
//
// This is the database half. The rule about WHO may look at WHOM is in
// hiring-manager-team-scope.ts, which is pure and holds the reasoning; nothing here re-decides it.
//
// TWO THINGS THIS MODULE DELIBERATELY DOES NOT DO.
//
//   • It does not let the viewer ANSWER for the manager below them. The owner asked for reading and
//     for commenting, and those are what exist. A National Sales Manager pressing "Not interested"
//     on a District Manager's card would overwrite that manager's own decision with no trace of
//     whose it was, and the two roles would then be indistinguishable in the candidate's history.
//   • It does not widen `listCandidatesSentToManager`. That function is reached from the sibling
//     route where the HR_ID comes from the session and can never be supplied by a caller. Keeping
//     the widened path in its own function means the narrow one stays narrow, and a future reader
//     cannot accidentally make the old route accept an id by editing the shared one.

import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { listCandidatesSentToManager } from "@/lib/recruitment/candidates";
import { recruitmentDb } from "@/lib/recruitment/db";
import { listCandidateCardFiles } from "@/lib/recruitment/files";
import {
  canViewerSeeManagerCandidates,
  managersWithinViewerTeam,
  type TeamManager,
  type TeamRosterEntry,
} from "@/lib/recruitment/hiring-manager-team-scope";
import type { TeamCandidateFile } from "@/lib/recruitment/types";
import type { Candidate } from "@/lib/recruitment/types";

/** A manager in the picker, with the one number that decides whether it is worth opening. */
export type TeamManagerWithCounts = TeamManager & {
  /** CVs a recruiter pushed to them, all time. */
  cvCount: number;
  /** …of those, the ones still waiting for their answer. */
  awaitingCount: number;
};

/**
 * The whole employee roster, as the hierarchy walk needs it.
 *
 * EVERY employee, not only the active ones, and that is load-bearing: the walk climbs
 * `manager_hr_id` from a person up to the viewer, so one inactive person anywhere in the middle of
 * that chain would break it and silently empty the picker below them. Filtering is a display
 * decision and belongs on the far side of the walk, never inside it.
 *
 * 179 rows in production on 2026-08-30, so this is one unpaged read on purpose — well under the
 * 1,000-row ceiling a PostgREST select stops at without saying so.
 */
async function loadTeamRoster(): Promise<TeamRosterEntry[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,full_name,job_title,manager_hr_id,pending_manager_replacement_for_hr_id,employment_status")
    .order("hr_id", { ascending: true })
    .limit(5000);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({
      employmentStatus: row.employment_status === null ? null : String(row.employment_status ?? ""),
      fullName: row.full_name === null ? null : String(row.full_name ?? ""),
      hrId: String(row.hr_id ?? ""),
      jobTitle: row.job_title === null ? null : String(row.job_title ?? ""),
      managerHrId: row.manager_hr_id === null ? null : String(row.manager_hr_id ?? ""),
      pendingManagerReplacementForHrId:
        row.pending_manager_replacement_for_hr_id === null
          ? null
          : String(row.pending_manager_replacement_for_hr_id ?? ""),
    }))
    .filter((entry) => entry.hrId.length > 0);
}

/**
 * How many CVs sit with each of these managers.
 *
 * Counted by reading the pushes for exactly these HR_IDs rather than by scanning the candidate
 * table: the set is a handful of managers, and the alternative — pulling every pushed row and
 * grouping in memory — is the shape that quietly stops at 1,000 once the module has been used for
 * a year.
 *
 * `hrIdLookupKeys` on both sides because HR_IDs here are MIXED CASE. A plain equality match on this
 * column has already under-returned by 28% elsewhere in this codebase, and a manager whose CVs read
 * as zero is indistinguishable from one who genuinely has none.
 */
async function countPushesByManager(managerHrIds: readonly string[]): Promise<Map<string, { all: number; awaiting: number }>> {
  const counts = new Map<string, { all: number; awaiting: number }>();
  const keys = managerHrIds.flatMap((hrId) => hrIdLookupKeys(hrId));
  if (keys.length === 0) return counts;

  const supabase = recruitmentDb();
  // Chunked at 50: a PostgREST `.in()` carrying several hundred ids returns zero rows and no error.
  for (let index = 0; index < keys.length; index += 50) {
    const chunk = keys.slice(index, index + 50);
    const { data, error } = await supabase
      .from("ats_candidates")
      .select("manager_notified_hr_id,status")
      .in("manager_notified_hr_id", chunk);
    if (error) {
      // 42703 = the column predates migration 20260815180000_candidate_manager_push. Absent counts
      // are a worse answer than zero counts, but they are not this caller's fault and must not take
      // the whole picker down with them.
      if ((error as { code?: string }).code === "42703") return counts;
      throw error;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = canonicalHrIdKey(String(row.manager_notified_hr_id ?? ""));
      if (!key) continue;
      const entry = counts.get(key) ?? { all: 0, awaiting: 0 };
      entry.all += 1;
      // "Awaiting" is the same question the manager's own card asks itself — a CV nobody has
      // answered yet. `sent_to_manager` and `new` are both that; anything else is a decision.
      const status = String(row.status ?? "").trim().toLowerCase();
      if (status === "new" || status === "sent_to_manager") entry.awaiting += 1;
      counts.set(key, entry);
    }
  }
  return counts;
}

/**
 * The managers this viewer may look at, with their counts — exactly what the picker renders.
 *
 * Returns an empty list for somebody who manages nobody, which is most callers. That is the correct
 * answer and the screen must render it as "you have no team here" rather than as an error.
 */
export async function listViewerTeamManagers(access: AccessContext): Promise<TeamManagerWithCounts[]> {
  if (!access.hrId) return [];
  const roster = await loadTeamRoster();
  const managers = managersWithinViewerTeam({ roster, viewerHrId: access.hrId });
  if (managers.length === 0) return [];

  const counts = await countPushesByManager(managers.map((manager) => manager.hrId));
  return managers.map((manager) => {
    const entry = counts.get(canonicalHrIdKey(manager.hrId) ?? "") ?? { all: 0, awaiting: 0 };
    return { ...manager, awaitingCount: entry.awaiting, cvCount: entry.all };
  });
}

/**
 * The CVs pushed to one manager beneath this viewer.
 *
 * THE GATE IS THE FIRST THING THAT HAPPENS, before any candidate row is read, and it throws rather
 * than returning an empty list. An out-of-scope id must not be answerable with "no candidates" —
 * that is a probe that succeeds, and it would let anyone holding this permission map the org by
 * asking about HR_IDs one at a time and watching which ones come back differently.
 */
export async function listTeamManagerCandidates(
  access: AccessContext,
  managerHrId: string,
): Promise<{ candidates: Candidate[]; files: Record<string, TeamCandidateFile[]>; manager: TeamManager | null }> {
  if (!access.hrId) throw new Error("Forbidden: no HR_ID on this session.");
  const roster = await loadTeamRoster();
  if (!canViewerSeeManagerCandidates({ managerHrId, roster, viewerHrId: access.hrId })) {
    throw new Error("Forbidden: that manager does not report to you.");
  }
  const manager =
    managersWithinViewerTeam({ roster, viewerHrId: access.hrId }).find(
      (entry) => canonicalHrIdKey(entry.hrId) === canonicalHrIdKey(managerHrId),
    ) ?? null;

  const candidates = await listCandidatesSentToManager(managerHrId);

  // The CV files come back WITH the list, in one query, rather than each card asking for its own.
  // The owner's rule for this screen is that the CV must be openable — "he must be able to screen
  // and must have a button to download the CV or to view it. It is a must." Per-card fetching met
  // that on paper and failed it in practice: seven cards meant seven requests, each re-walking the
  // org chart to authorise, and the buttons took about fifteen seconds to appear.
  //
  // Authorisation is NOT skipped by doing it here — it has already happened, once, for the whole
  // list: the caller was proven to be above this manager before any candidate row was read, and
  // every candidate in this list belongs to that manager by construction.
  const files = await listCandidateCardFiles(candidates.map((candidate) => candidate.id));

  return { candidates, files, manager };
}

/**
 * True when this viewer may read (and comment on) this candidate because of who it was pushed to.
 *
 * The candidate's own row names the manager, so this is the CV-level form of the same gate: one
 * read of the candidate, one walk of the roster. Used by the comment route, which must not accept a
 * candidate id the viewer could not have seen on any of their screens.
 */
export async function isCandidateWithinViewerTeam(access: AccessContext, candidateId: string): Promise<boolean> {
  if (!access.hrId) return false;
  const { data, error } = await recruitmentDb()
    .from("ats_candidates")
    .select("*")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  const stamped = (data as { manager_notified_hr_id?: unknown } | null)?.manager_notified_hr_id;
  if (!stamped) return false;
  const roster = await loadTeamRoster();
  return canViewerSeeManagerCandidates({
    managerHrId: String(stamped),
    roster,
    viewerHrId: access.hrId,
  });
}
