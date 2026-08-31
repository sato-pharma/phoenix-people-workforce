// Recruitment / ATS — reading the district folders out of the database.
//
// The rule itself is in district-manager-folders.ts and is deliberately pure. This is the half that
// talks to Postgres: the organogram on one side, the CV pool on the other, handed to that rule and
// narrowed to the one person allowed to open them.
//
// ── WHAT A DISTRICT MANAGER CAN NOW SEE, STATED PLAINLY ─────────────────────────────────────────
//
// This WIDENS what a manager sees, and it is the widening the owner asked for: "populate the folders
// based on the CVs we receive. So if you need a CV from any area, he click the folder and open he
// find all CVs." Until today a manager saw only the CVs a recruiter had pushed to him. He now also
// sees every CV whose applicant SAID they want to work in one of his own areas.
//
// The scope is his areas and nothing else. It is not "all candidates" — it is derived from the org
// tree seat by seat, so a district manager sees his districts, an NSM covering a vacant district
// sees that district, and somebody holding no district seat gets an empty list rather than a
// company-wide one. That direction matters: a picker is never wider than its viewer, and a
// company-wide list has already offered one medical rep the names of every rep in the company.
//
// ── AND THE ARCHIVE REACHES THEM TOO, WHICH IS THE BACKFILL ─────────────────────────────────────
//
// The owner, 2026-08-31: *"you will start backfilling from the historicals ... the two hundred
// eligible, you will backfill them. But anyone non eligible, you will make the admin be able to
// check first their CV and confirm."* A CV that arrived before the apply flow existed named no area
// and answered no question, so it reaches a REGION through the governorate its own text mentions,
// and lands in that district's "No area named" folder rather than beside people who asked for the
// area by name. Only CVs the background judge reads as eligible go that way; paramedical and
// unreadable ones wait for an admin, which is what he asked for.
//
// ── WHAT NEVER REACHES A FOLDER ─────────────────────────────────────────────────────────────────
//
// A rejection, a paramedical CV (shelved or judged), and an area that was READ off a CV rather than
// declared by the applicant. All of them are refused inside the pure rule, where they can be tested
// without a database, and none of them is refused again here — this file must not grow a second
// copy of a policy that would then drift from the one the tests pin.

import { logError } from "@/lib/observability/log";
import { mapCandidate, recruitmentDb, type CandidateDbRow } from "@/lib/recruitment/db";
import {
  boardsForManager,
  DISTRICT_SEAT_COLUMNS,
  districtManagerBoards,
  placeCandidatesInDistrictFolders,
  type DistrictManagerBoard,
  type DistrictSeatRow,
  type UnplacedDeclaration,
} from "@/lib/recruitment/district-manager-folders";
import { isReturnSuppressed, loadManagerReturnSuppressions } from "@/lib/recruitment/district-returns";
import type { Candidate } from "@/lib/recruitment/types";

/** A board carrying whole candidate records, which is what every screen renders. */
export type DistrictBoard = DistrictManagerBoard<Candidate>;

/**
 * The organogram.
 *
 * A failed read degrades to no boards rather than throwing. This section is an addition to a page
 * that already works without it, and taking My Candidates down because a view was slow would cost a
 * manager the CVs actually sent to him in order to fail at showing him the ones that were not.
 */
async function loadDistrictSeatRows(): Promise<DistrictSeatRow[]> {
  const { data, error } = await recruitmentDb().from("au_v_org_tree").select(DISTRICT_SEAT_COLUMNS);
  if (error) {
    logError("District CV folders could not read the org tree", {
      error,
      labels: { event: "district_folders_tree_read_failed" },
    });
    return [];
  }
  return (data ?? []) as DistrictSeatRow[];
}

/**
 * How many rows are fetched per request, and why this is paged at all.
 *
 * An unbounded PostgREST select stops at 1000 rows with no error and no marker, and the failure that
 * produces here is invisible: the 1001st applicant simply never appears in anybody's folder, and an
 * empty area folder is indistinguishable from an area nobody has applied to. Production holds about
 * 600 CVs today, so this pages twice — the point is that it will still be correct at 20,000.
 */
const PAGE_SIZE = 500;
const MAX_PAGES = 40;

/**
 * Every CV that could reach a folder, newest first.
 *
 * IT NO LONGER FILTERS, AND THAT IS THE BACKFILL. Until the owner asked for the historicals this
 * query asked Postgres for the CVs that declared an area, which was cheap and reached about 120
 * rows. Not one of the 420 live archived CVs declared one — they predate the question — so the same
 * filter now excludes precisely the pool it was told to include. Everything is read and the pure
 * rule decides, which is also where the decision is testable without a database.
 *
 * A `neq` on status is deliberately NOT used to drop the rejected ones here. PostgREST's `neq`
 * excludes NULLs as well, so a CV whose status was never set would vanish from every folder with no
 * error anywhere — and `canFileCandidate` already refuses the rejected ones in the rule.
 */
async function loadRoutableCandidates(): Promise<Candidate[]> {
  const supabase = recruitmentDb();

  const counted = await supabase
    .from("ats_candidates")
    .select("id", { count: "exact", head: true });
  if (counted.error) {
    logError("District CV folders could not count the CVs", {
      error: counted.error,
      labels: { event: "district_folders_candidate_count_failed" },
    });
  }

  const rows: CandidateDbRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from("ats_candidates")
      .select("*")
      // Ordered explicitly, and with a UNIQUE column as the tie-break. Paging an unordered result is
      // how one row is fetched twice and another never at all — Postgres makes no promise that two
      // requests order equal rows the same way.
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      logError("District CV folders could not read the CVs", {
        error,
        labels: { event: "district_folders_candidate_read_failed", page: String(page) },
      });
      break;
    }
    const batch = (data ?? []) as CandidateDbRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  // The count is a CHECK, not a limit. If the two disagree, the folders are short of somebody — and
  // a folder quietly missing a CV is worse than an empty one, because it reads as an answer. This is
  // the only signal that would ever say so.
  const expected = counted.count ?? null;
  if (expected !== null && expected !== rows.length) {
    logError("District CV folders fetched a different number of CVs than exist", {
      labels: {
        event: "district_folders_candidate_count_mismatch",
        expected: String(expected),
        fetched: String(rows.length),
      },
    });
  }

  return rows.map((row) => mapCandidate(row));
}

/**
 * Every district's folders, for the whole company.
 *
 * Never handed to a screen as it stands — every caller narrows it to one manager first. It is
 * separate because the unplaced list belongs to the recruitment team rather than to a manager: a CV
 * that named "Qena" reached nobody's folder, and somebody has to be told that.
 */
export async function loadAllDistrictBoards(): Promise<{
  boards: DistrictBoard[];
  unplaced: UnplacedDeclaration[];
  placements: number;
}> {
  const [rows, candidates] = await Promise.all([loadDistrictSeatRows(), loadRoutableCandidates()]);
  if (rows.length === 0) return { boards: [], placements: 0, unplaced: [] };
  return placeCandidatesInDistrictFolders({ candidates, rows });
}

/**
 * The folders this one person opens.
 *
 * Returns an empty list for anybody holding no district seat, which is most people who reach the
 * portal. A screen renders nothing at all then, rather than an empty heading.
 */
export async function listDistrictBoardsForManager(
  managerHrId: string | null | undefined,
): Promise<DistrictBoard[]> {
  if (!String(managerHrId ?? "").trim()) return [];

  // THE SEATS FIRST, AND THE CVs ONLY IF HE HOLDS ANY. Most people who open My Candidates hold no
  // district seat at all, and for them the candidate sweep would be work done to produce an empty
  // array — on every page load. The tree read is one small view; the candidate read is the one that
  // grows with the applicant pool, so it is the one worth not doing.
  const rows = await loadDistrictSeatRows();
  if (rows.length === 0) return [];
  if (boardsForManager(districtManagerBoards(rows), managerHrId).length === 0) return [];

  // His returns are read alongside the CV sweep, not before it: a CV he has handed back to the
  // administrator drops out of his folders here, and stays in every other line's. The report path
  // (loadAllDistrictBoards) deliberately does NOT do this — a returned CV was still received.
  const [candidates, suppressedReturns] = await Promise.all([
    loadRoutableCandidates(),
    loadManagerReturnSuppressions(managerHrId),
  ]);
  const { boards } = placeCandidatesInDistrictFolders({ candidates, rows, suppressedReturns });
  return boardsForManager(boards, managerHrId);
}

/**
 * May this caller open THIS CV, because its applicant asked for one of his own areas?
 *
 * A FOURTH ROUTE INTO HIRING-MANAGER SCOPE, and without it the folders would be a screen that
 * cannot be used. The other three all key on a CV having been PUSHED to somebody — to the caller, to
 * somebody below him, or to a requisition he owns — and a CV sitting in a district folder has been
 * pushed to nobody by definition. Every card would render a View CV button that answers 403 and a
 * comment box that refuses to load, which is a worse screen than no screen at all.
 *
 * IT ASKS THE RULE, IT DOES NOT RESTATE IT. The same placement that put the CV in front of him is
 * what answers here — one candidate through `placeCandidatesInDistrictFolders`, against his own
 * boards — so an applicant the folders would not show is an applicant this refuses, permanently and
 * without a second copy of the policy to drift. A rejection, a paramedical confirmation and an
 * extracted-not-declared area are all refused in there.
 *
 * Cheap: one candidate row plus the org tree, no candidate sweep.
 *
 * TWO FUNCTIONS, ONE PLACEMENT. `districtBoardsHoldingCandidate` answers "whose folders is this CV
 * in" and is deliberately not scoped to anybody — the scoping is the caller's question, and a
 * National Sales Manager reading a district manager's folder needs a DIFFERENT answer to the one
 * below without needing a second copy of the placement. That caller is
 * `isCandidateInViewerTeamDistrict` in hiring-manager-team.ts, which lives there rather than here
 * because it needs the team roster and this module must not import that one back — the dependency
 * runs one way, and PR #2816 already paid for a cycle in this area with a Turbopack build crash.
 */
export async function districtBoardsHoldingCandidate(candidateId: string): Promise<DistrictBoard[]> {
  if (!String(candidateId ?? "").trim()) return [];

  const { data, error } = await recruitmentDb()
    .from("ats_candidates")
    .select("*")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return [];

  const rows = await loadDistrictSeatRows();
  if (rows.length === 0) return [];

  const { boards } = placeCandidatesInDistrictFolders({
    candidates: [mapCandidate(data as CandidateDbRow)],
    rows,
  });
  return boards.filter((board) => board.candidateCount > 0);
}

export async function isCandidateInViewerDistrict(
  viewerHrId: string | null | undefined,
  candidateId: string,
): Promise<boolean> {
  if (!(await isCandidateInViewerDistrictScope(viewerHrId, candidateId))) return false;
  // A CV he returned to the administrator is no longer his to open — the same decision that drops it
  // from his folder revokes his access to its file and comment thread. Checked after the cheaper
  // placement so the read only happens for a CV that was actually in his district.
  return !(await isReturnSuppressed(viewerHrId, candidateId));
}

/**
 * The SAME "is this CV in his district" question, but blind to any return he has already made.
 *
 * This is what the return route gates on, and the difference is the whole point: isCandidateInViewer
 * District above answers "may he still OPEN it", which a returned CV fails; this answers "was it ever
 * his to return", which a returned CV still passes. Gating the return on the suppression-aware check
 * would make the second press a 403 instead of the honest "already returned", and would forbid a
 * manager from ever correcting a note on a return he just made.
 */
export async function isCandidateInViewerDistrictScope(
  viewerHrId: string | null | undefined,
  candidateId: string,
): Promise<boolean> {
  if (!String(viewerHrId ?? "").trim()) return false;
  const holding = await districtBoardsHoldingCandidate(candidateId);
  return boardsForManager(holding, viewerHrId).length > 0;
}

/** Every candidate id on these boards, deduplicated — one CV can sit in three managers' folders. */
export function districtBoardCandidateIds(boards: readonly DistrictBoard[]): string[] {
  const ids = new Set<string>();
  for (const board of boards) {
    for (const folder of board.folders) {
      for (const candidate of folder.candidates) ids.add(candidate.id);
    }
  }
  return [...ids];
}
