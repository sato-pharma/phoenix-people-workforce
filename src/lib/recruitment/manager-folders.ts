// Recruitment / ATS — reading and writing a manager's own CV shelf.
//
// The database half of manager-folder-shelf.ts, which is pure and holds the reasoning about what a
// shelf IS. Nothing in this file re-decides the vocabulary; it validates against the recruiter's own
// module and stores the result in ats_candidate_manager_folders.
//
// THE SCOPE RULE IS NOT HERE, AND THAT IS DELIBERATE. Whether this caller may see this candidate at
// all is answered by assertCandidateInHiringManagerScope in hiring-manager-view.ts — the same gate
// the CV download goes through, with its three routes into scope. A second copy of that walk living
// here is how the two would eventually disagree about who may open what, so the routes call the gate
// and then call these functions.

import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import {
  candidateFolderRefusal,
  cleanFolderKey,
  isCandidateFolderKind,
} from "@/lib/recruitment/candidate-folder";
import { getCandidate } from "@/lib/recruitment/candidates";
import { recruitmentDb } from "@/lib/recruitment/db";
import type { ManagerFolderFiling, ManagerFolderFilings } from "@/lib/recruitment/manager-folder-shelf";
import { fetchAllRows } from "@/lib/supabase/paginated";

/**
 * "That table is not there" — BOTH spellings of it.
 *
 * `42P01` is Postgres's own undefined_table, and it is what this guard was written against. It is
 * also NOT what comes back: PostgREST answers a missing table from its schema cache, with
 * `PGRST205` and no Postgres error code at all. Checking only 42P01 therefore looks correct, reads
 * correct, and catches nothing — measured 2026-08-30 against a database without the table, where the
 * manager's whole My Candidates page 500'd instead of showing an empty shelf.
 *
 * Kept as a named constant so the read path and the delete path cannot drift apart on it.
 */
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && MISSING_TABLE_CODES.has(code);
}

/** What one stored row looks like coming back. */
type ManagerFolderRow = {
  candidate_id: unknown;
  kind: unknown;
  folder_key: unknown;
  filed_at: unknown;
  filed_by_hr_id: unknown;
};

function mapFiling(row: ManagerFolderRow): ManagerFolderFiling | null {
  const kind = String(row.kind ?? "");
  const key = cleanFolderKey(String(row.folder_key ?? ""));
  // A row whose kind is not one this build knows is skipped rather than shown. The CHECK constraint
  // makes it unreachable through the app, but a shelf renamed in a later release would arrive here
  // first, and the safe failure is "this CV is still in your list" rather than "this CV is in a
  // folder you cannot open".
  if (!isCandidateFolderKind(kind) || !key) return null;
  return {
    filedAt: String(row.filed_at ?? ""),
    filedByHrId: row.filed_by_hr_id === null || row.filed_by_hr_id === undefined ? null : String(row.filed_by_hr_id),
    filedByName: null,
    key,
    kind,
  };
}

/**
 * Everything this manager has filed, keyed by candidate id.
 *
 * Read by the manager's NORMALISED HR_ID, never by a raw equality: HR_IDs here are mixed case, and a
 * plain `.eq` on one has already lost 28% of a result set elsewhere in this codebase. A filing that
 * fails to come back does not read as an error — it reads as a CV the manager never filed, sitting
 * back in his inbox — which is precisely the kind of silent wrong answer that gets believed.
 *
 * A missing table answers "nothing filed" rather than throwing. This module ships with its migration
 * in the same PR, but a Railway deploy applies NO migrations — so the app can reach production
 * minutes before the table does, and without this the whole My Candidates page 500s in that window.
 * An empty shelf is a survivable wrong answer; a dead screen is not. MEASURED, not assumed: with the
 * table absent, the page threw and the portal rendered its error boundary.
 */
export async function listManagerFolderFilings(managerHrId: string | null | undefined): Promise<ManagerFolderFilings> {
  const key = canonicalHrIdKey(managerHrId);
  if (!key) return {};

  // Paged to the end: a fixed row ceiling would send a filed CV back to his inbox without a sound.
  let data: ManagerFolderRow[];
  try {
    data = await fetchAllRows<ManagerFolderRow>(
      () =>
        recruitmentDb()
          .from("ats_candidate_manager_folders")
          .select("candidate_id,kind,folder_key,filed_at,filed_by_hr_id")
          .eq("manager_hr_id_norm", key)
          .order("filed_at", { ascending: false }),
      "candidate_id",
    );
  } catch (error) {
    // See isMissingTable: PostgREST says PGRST205, not 42P01.
    if (isMissingTable(error)) return {};
    throw error;
  }

  const filings: ManagerFolderFilings = {};
  for (const row of data) {
    const candidateId = String(row.candidate_id ?? "");
    const filing = mapFiling(row);
    if (candidateId && filing) filings[candidateId] = filing;
  }
  return filings;
}

/**
 * Put a CV on this manager's shelf — or move it, if he had already filed it somewhere else.
 *
 * Upserted on (candidate_id, manager_hr_id_norm) so filing again MOVES the CV rather than leaving
 * two rows that two screens would disagree about. The refusal rule is the recruiter's own
 * `candidateFolderRefusal`, imported rather than restated: a rejected CV is not waiting on a seat,
 * and a manager must not be able to bury a decision that has already been made.
 */
export async function fileCandidateForManager(
  access: AccessContext,
  candidateId: string,
  kind: string,
  key: string,
): Promise<ManagerFolderFiling> {
  const managerHrId = String(access.hrId ?? "").trim();
  const managerKey = canonicalHrIdKey(managerHrId);
  if (!managerKey) throw new Error("Forbidden: no HR_ID on this session.");

  if (!isCandidateFolderKind(kind)) {
    throw new Error(`"${String(kind ?? "").trim()}" is not a folder kind.`);
  }
  const cleanKey = cleanFolderKey(key);
  if (!cleanKey) throw new Error("A folder needs a name.");

  const candidate = await getCandidate(candidateId);
  if (!candidate) throw new Error("Candidate not found.");
  const refusal = candidateFolderRefusal(candidate);
  if (refusal) throw new Error(refusal);

  const filedAt = new Date().toISOString();
  const { data, error } = await recruitmentDb()
    .from("ats_candidate_manager_folders")
    .upsert(
      {
        candidate_id: candidateId,
        filed_at: filedAt,
        filed_by_hr_id: hrIdForStorage(access.hrId),
        folder_key: cleanKey,
        kind,
        manager_hr_id: managerHrId,
        manager_hr_id_norm: managerKey,
      },
      { onConflict: "candidate_id,manager_hr_id_norm" },
    )
    .select("candidate_id,kind,folder_key,filed_at,filed_by_hr_id")
    .single();
  if (error) throw error;

  const filing = mapFiling(data as ManagerFolderRow);
  if (!filing) throw new Error("Failed to file this CV.");
  return filing;
}

/**
 * Take a CV back off this manager's shelf.
 *
 * Succeeds on a CV that is already back, rather than erroring. The button is one click on a screen
 * the same person can have open on a phone and a laptop, and the honest answer to "put it back" when
 * it is already back is yes.
 */
export async function unfileCandidateForManager(access: AccessContext, candidateId: string): Promise<void> {
  const managerKey = canonicalHrIdKey(access.hrId);
  if (!managerKey) throw new Error("Forbidden: no HR_ID on this session.");

  const { error } = await recruitmentDb()
    .from("ats_candidate_manager_folders")
    .delete()
    .eq("candidate_id", candidateId)
    .eq("manager_hr_id_norm", managerKey);
  if (error && !isMissingTable(error)) throw error;
}
