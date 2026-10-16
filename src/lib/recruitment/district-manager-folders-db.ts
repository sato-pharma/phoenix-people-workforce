// Recruitment / ATS — reading every manager's CV folders out of the database.
//
// THE FOLDERS ARE FILLED BY SENDS AND NOTHING ELSE (owner, 2026-10-16: "no more managers receive CVs
// automatic ... the TA or admin push a CV whenever needed and can any time get it back"). The shelves
// are the organogram's — a folder per area, empty — and a CV is in one because a row in
// `ats_candidate_manager_sends` says a person sent it to that manager. Until 2026-10-16 this file swept
// the whole CV pool and let a placement rule decide who "should" receive each applicant; it no longer
// reads the pool at all. The shelf and fill rules are pure, in manager-cv-folders.ts.
//
// WHAT A MANAGER SEES IS HIS OWN SENDS, with no 45-day limit (owner, 2026-10-16: a manager who holds
// folders keeps a CV until it is taken back or he returns it — folder-holders.ts). Taking a CV
// back is deleting that send row (manager-recall.ts), and a manager's own Return does the same, so
// the folder, the gates and the reminders all read one fact and cannot disagree about whose CV it is.

import { mapCandidate, recruitmentDb, type CandidateDbRow } from "@/lib/recruitment/db";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { boardsForManager, type DistrictManagerBoard, type UnplacedDeclaration } from "@/lib/recruitment/district-manager-folders";
import {
  fillShelvesFromSends,
  managerFolderShelves,
  type FolderSend,
} from "@/lib/recruitment/manager-cv-folders";
import { loadDistrictSeatRows } from "@/lib/recruitment/folder-holders";
import {
  isCandidateSentToManager,
  listAllManagerSends,
  listSendsForCandidate,
  listSendsForManager,
  managerSendStamp,
  type ManagerSend,
} from "@/lib/recruitment/manager-sends";
import type { Candidate } from "@/lib/recruitment/types";

/** A board carrying whole candidate records, which is what every screen renders. */
export type DistrictBoard = DistrictManagerBoard<Candidate>;

// The organogram read lives in folder-holders.ts (manager-sends.ts needs it too, and cannot import
// this file back). A failed read degrades to no boards rather than throwing.
export { loadDistrictSeatRows };

function folderSendOf(send: ManagerSend): FolderSend {
  return {
    candidateId: send.candidateId,
    folderArea: send.position?.areaName ?? null,
    managerHrId: send.managerHrId,
    sentAt: send.sentAt,
  };
}

/** The CVs named by these ids, keyed by id. Batched because the list grows with the sends. */
async function loadCandidatesById(ids: readonly string[]): Promise<Map<string, Candidate>> {
  const found = new Map<string, Candidate>();
  const supabase = recruitmentDb();
  for (const batch of chunkIds([...new Set(ids)])) {
    const { data, error } = await supabase.from("ats_candidates").select("*").in("id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as CandidateDbRow[]) {
      const candidate = mapCandidate(row);
      found.set(candidate.id, candidate);
    }
  }
  return found;
}

/**
 * Every manager's folders, for the whole company, with every send ever made — the 45-day window is
 * deliberately NOT applied, because a CV that aged out of an account was still received. Used by the
 * engagement report. Never handed to a screen as it stands.
 *
 * `unplaced` is always empty now: nothing is placed automatically, so nothing can fail to be.
 */
export async function loadAllDistrictBoards(): Promise<{
  boards: DistrictBoard[];
  unplaced: UnplacedDeclaration[];
  placements: number;
}> {
  const [rows, sends] = await Promise.all([loadDistrictSeatRows(), listAllManagerSends()]);
  if (rows.length === 0 || !sends || sends.length === 0) return { boards: [], placements: 0, unplaced: [] };
  const candidates = await loadCandidatesById(sends.map((send) => send.candidateId));
  const boards = fillShelvesFromSends({
    candidates,
    sends: sends.map(folderSendOf),
    shelves: managerFolderShelves<Candidate>(rows),
  });
  return { boards, placements: boards.reduce((total, board) => total + board.candidateCount, 0), unplaced: [] };
}

/**
 * The folders this one person opens — every area on his shelf, and in each the CVs sent to him.
 *
 * Returns an empty list for anybody holding no seat on the organogram, which is most people who reach
 * the portal. A screen renders nothing at all then, rather than an empty heading.
 */
export async function listDistrictBoardsForManager(
  managerHrId: string | null | undefined,
): Promise<DistrictBoard[]> {
  if (!String(managerHrId ?? "").trim()) return [];

  const rows = await loadDistrictSeatRows();
  if (rows.length === 0) return [];
  const shelves = boardsForManager(managerFolderShelves<Candidate>(rows), managerHrId);
  if (shelves.length === 0) return [];

  // listSendsForManager applies no cutoff to a folder holder (owner, 2026-10-16). null means the sends table is not in this database yet — empty shelves, not an error.
  const sends = (await listSendsForManager(managerHrId)) ?? [];
  if (sends.length === 0) return shelves;
  const candidates = await loadCandidatesById(sends.map((send) => send.candidateId));
  // HIS OWN SEND, overlaid on the candidate's shared columns: those hold whoever was sent the CV
  // last, so without this a card would show another manager's date and position as his own.
  for (const send of sends) {
    const candidate = candidates.get(send.candidateId);
    if (candidate) candidates.set(candidate.id, { ...candidate, ...managerSendStamp(send) });
  }
  return fillShelvesFromSends({ candidates, sends: sends.map(folderSendOf), shelves });
}

/**
 * Whose folders is this CV in, right now? Every manager with a live send of it, as the board it sits
 * on. Deliberately not scoped to anybody — the scoping is the caller's question — and an empty list
 * means no manager holds it. A National Sales Manager reading a district manager's folder is answered
 * by `isCandidateInViewerTeamDistrict` in hiring-manager-team.ts, which asks this and then the roster;
 * it lives there because it needs the roster and this module must not import that one back.
 */
export async function districtBoardsHoldingCandidate(candidateId: string): Promise<DistrictBoard[]> {
  const id = String(candidateId ?? "").trim();
  if (!id) return [];

  // No window here: a board exists only for a manager who holds folders, and folders are not held to
  // the 45 days (owner, 2026-10-16).
  const live = await listSendsForCandidate(id);
  if (live.length === 0) return [];

  const { data, error } = await recruitmentDb().from("ats_candidates").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return [];
  const candidate = mapCandidate(data as CandidateDbRow);

  const rows = await loadDistrictSeatRows();
  if (rows.length === 0) return [];
  return fillShelvesFromSends({
    candidates: new Map([[candidate.id, candidate]]),
    sends: live.map(folderSendOf),
    shelves: managerFolderShelves<Candidate>(rows),
  }).filter((board) => board.candidateCount > 0);
}

/**
 * May this caller open THIS CV because it is in one of his own folders? That is, a person sent it to
 * him, inside its 45 days. A return he made removes the send, so this needs no second check.
 */
export async function isCandidateInViewerDistrict(
  viewerHrId: string | null | undefined,
  candidateId: string,
): Promise<boolean> {
  return isCandidateInViewerDistrictScope(viewerHrId, candidateId);
}

/**
 * The same question, named for the routes that gate a return or a call on "was it ever his". Kept as
 * its own name because those routes are pinned by it; there is no longer any difference to draw.
 */
export async function isCandidateInViewerDistrictScope(
  viewerHrId: string | null | undefined,
  candidateId: string,
): Promise<boolean> {
  if (!String(viewerHrId ?? "").trim()) return false;
  return (await isCandidateSentToManager(candidateId, viewerHrId)) === true;
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

/**
 * This manager's empty shelves — the folders a CV can be sent into. Empty for a manager who holds no
 * seat on the organogram (a head-office manager), who keeps "Sent to you" and nothing else.
 */
export async function loadManagerShelves(managerHrId: string | null | undefined): Promise<DistrictBoard[]> {
  if (!String(managerHrId ?? "").trim()) return [];
  const rows = await loadDistrictSeatRows();
  if (rows.length === 0) return [];
  return boardsForManager(managerFolderShelves<Candidate>(rows), managerHrId);
}
