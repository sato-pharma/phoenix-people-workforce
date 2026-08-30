// Recruitment / ATS — a MANAGER's own CV shelf, folded from his own filings.
//
// The owner, 2026-08-30, looking at the manager's portal: *"and I want him to have a folders like
// like me."*
//
// "Like me" is meant literally, and this module is what makes it literal rather than a second
// implementation that drifts. The three shelves, the folder keys, the labels, the sort order and
// the rule about which CVs leave the live list all come from candidate-folder.ts — the recruiter's
// module — and nothing here re-decides any of them. The ONLY thing this file does is answer a
// different question about WHOSE filing counts:
//
//   the recruiter's shelf   reads ats_candidates.folder_kind / folder_key   — one per CV
//   the manager's shelf     reads ats_candidate_manager_folders             — one per CV PER MANAGER
//
// WHY THEY MUST BE SEPARATE. Filing on the recruiter's shelf removes a CV from the pool every
// recruiter works from. If a District Manager tidying his own inbox wrote to those same columns, the
// CV would vanish from Talent Acquisition's screen with nothing anywhere explaining where it went,
// and the second manager to file the same candidate would silently overwrite the first. The
// migration comment on ats_candidate_manager_folders carries the same reasoning at length.
//
// PURE — no database, no React. Same rule as candidate-folder.ts and for the same reason: this is
// reached from a "use client" component, so a database import anywhere in the chain would drag the
// service-role client into the browser bundle.

import {
  partitionCandidatesByFolder,
  type CandidateFolderKind,
  type CandidateFolderShelf,
} from "@/lib/recruitment/candidate-folder";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type { Candidate } from "@/lib/recruitment/types";

/**
 * One manager's filing of one CV.
 *
 * Deliberately the SAME shape as `Candidate["folder"]`, because that is what lets the overlay below
 * hand the recruiter's own partition function a candidate it already understands. If these two
 * shapes are ever allowed to diverge, this module stops being a viewing angle and becomes a fork.
 */
export type ManagerFolderFiling = NonNullable<Candidate["folder"]>;

/** Filings keyed by candidate id, as the DB half returns them and the screen holds them. */
export type ManagerFolderFilings = Record<string, ManagerFolderFiling>;

/**
 * The same candidates, wearing THIS manager's filings instead of the recruitment team's.
 *
 * The overlay is unconditional: a CV the recruitment team has filed but this manager has not reads
 * as UNFILED here, and that is correct rather than a lost filing. The two shelves answer two
 * different questions — "has Talent Acquisition parked this" and "have I parked this" — and showing
 * a manager a folder he did not create, in a filing cabinet labelled as his, would make the one
 * button on the card ("Return to my list") appear to do nothing.
 */
export function applyManagerFilings(
  candidates: readonly Candidate[],
  filings: ManagerFolderFilings,
): Candidate[] {
  return candidates.map((candidate) => ({ ...candidate, folder: filings[candidate.id] ?? null }));
}

/**
 * A manager's inbox split into what still needs him and what he has shelved.
 *
 * One call, one partition, exactly as the recruiter's screen does it — so a CV is in `live` or on a
 * shelf and never in both or neither. `shelves` always contains all three, empty ones included:
 * an empty shelf says nothing has been filed there yet, while a shelf that disappears when it
 * empties makes the feature look broken the first time somebody opens it.
 */
export function partitionManagerCandidates(
  candidates: readonly Candidate[],
  filings: ManagerFolderFilings,
): { live: Candidate[]; shelves: CandidateFolderShelf[]; filedCount: number } {
  const { pool, shelves, filedCount } = partitionCandidatesByFolder(applyManagerFilings(candidates, filings));
  return { filedCount, live: pool, shelves };
}

/**
 * The filings map with one candidate set or cleared — what a screen holds after a file/unfile.
 *
 * Returns a NEW object rather than mutating, so React sees the change; and it is here rather than
 * inline in the component because both the manager's own list and his team's list have to do it and
 * two copies of a merge like this is how one of them ends up forgetting the delete case.
 */
export function withManagerFiling(
  filings: ManagerFolderFilings,
  candidateId: string,
  filing: ManagerFolderFiling | null,
): ManagerFolderFilings {
  const next = { ...filings };
  if (filing) next[candidateId] = filing;
  else delete next[candidateId];
  return next;
}

/**
 * True when this filing belongs to this manager.
 *
 * HR_IDs in this database are MIXED CASE — a plain equality has already under-returned by 28%
 * elsewhere in this codebase — so both sides go through `canonicalHrIdKey`, which also folds the
 * legacy alias aaa -> aa. The stored column `manager_hr_id_norm` is written with the same function,
 * which is what keeps the SQL side and this side from drifting.
 */
export function isManagersOwnFiling(
  managerHrId: string | null | undefined,
  filedForHrId: string | null | undefined,
): boolean {
  const left = canonicalHrIdKey(managerHrId);
  const right = canonicalHrIdKey(filedForHrId);
  return Boolean(left && right && left === right);
}

/** The shelf a filing sits on, when a screen needs to name it without unpacking the whole partition. */
export function filingShelfKind(filing: ManagerFolderFiling | null | undefined): CandidateFolderKind | null {
  return filing?.kind ?? null;
}
