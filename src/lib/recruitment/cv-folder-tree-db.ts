// Recruitment / ATS — reading and writing the hand-built CV folder tree.
//
// The database half of cv-folder-tree.ts, which is pure and holds every rule about what a legal tree
// IS. Nothing here re-decides depth, cycles, naming or uniqueness: each write asks that module first,
// on the rows it has just read, and stores the result. Same split as manager-folders.ts over
// manager-folder-shelf.ts.
//
// ── EVERY WRITE READS THE WHOLE TREE FIRST, AND THAT IS CHEAP ON PURPOSE ────────────────────────
//
// A move or a create cannot be judged from the row being changed: legality depends on the folder's
// ancestors (depth), its descendants (cycles), and its siblings (name). The tree is a few hundred
// rows of three short columns, so one `select` answers all three, and the alternative — three
// targeted queries, or a recursive CTE — is more round trips to learn less.
//
// ── THE RACE, AND WHY THE DATABASE STILL CARRIES THE RULE ───────────────────────────────────────
//
// Two recruiters creating "Alex" under the same parent in the same second both read a tree without
// it and both pass validation. The partial unique indexes in the migration are what makes the second
// insert fail rather than produce two folders with one name, and `describeUniqueViolation` below
// turns that failure back into the same sentence the pre-check would have given. The check is for
// the sentence; the index is for the truth.

import { cache } from "react";

import type { AccessContext } from "@/lib/auth/permissions";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { hrIdForStorage } from "@/lib/hr-id";
import {
  cvFolderNameKey,
  describeCvFolderCreateRefusal,
  describeCvFolderMoveRefusal,
  describeCvFolderRenameRefusal,
  normalizeCvFolderName,
  collectCvFolderSubtreeIds,
  type CvFolderRow,
} from "@/lib/recruitment/cv-folder-tree";
import { recruitmentDb } from "@/lib/recruitment/db";
import { chunkIds } from "@/lib/recruitment/db-batch";

/**
 * "That table is not there" — BOTH spellings of it.
 *
 * `42P01` is Postgres's own undefined_table and it is NOT what comes back: PostgREST answers a
 * missing table from its schema cache with `PGRST205` and no Postgres error code at all. Checking
 * only 42P01 looks correct and catches nothing — the manager-folders module carries the same set for
 * the same reason, after the whole My Candidates page 500'd against a database without its table.
 *
 * It matters here because the recruitment hub loads this tree on every render. In the window between
 * this code deploying and the migration being applied, the honest failure is an empty tree, not a
 * recruitment module nobody can open.
 */
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && MISSING_TABLE_CODES.has(code);
}

/** Postgres's unique_violation — the losing half of the create/rename race described in the header. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "23505";
}

const HR_ID_LOOKUP_CHUNK = 50;

/** Everything a screen needs about the tree, in the two reads it takes. */
export type CvFolderCabinet = {
  rows: CvFolderRow[];
  /** folder id -> the candidate ids filed in it. Empty folders are absent, not empty arrays. */
  members: Map<string, string[]>;
  /**
   * Every candidate with at least one filing anywhere in the tree.
   *
   * The pool's own question, answered once. Kept beside `members` rather than derived by every
   * caller, because "is this CV hidden?" and "what is in this folder?" disagreeing is the single
   * failure this feature could produce that loses a person.
   */
  filedCandidateIds: Set<string>;
};

function mapFolderRow(row: Record<string, unknown>): CvFolderRow {
  return {
    createdAt: String(row.created_at ?? ""),
    createdByHrId: row.created_by_hr_id ? String(row.created_by_hr_id) : null,
    createdByName: null,
    id: String(row.id),
    name: String(row.name ?? ""),
    parentId: row.parent_id ? String(row.parent_id) : null,
  };
}

/**
 * Resolve who made each folder into a NAME.
 *
 * The owner's standing rule is names, never raw codes, and `created_by_hr_id` is a code. The read
 * itself is the shared `namesByHrId` — the mixed-case trap, the chunking and the nickname all live
 * there — and a failure costs the names and nothing else: a folder tree that renders without a
 * creator's name is fine, one that fails to render because the employees table hiccuped is not.
 */
async function attachFolderCreatorNames(rows: CvFolderRow[]): Promise<void> {
  const names = await namesByHrId(
    new Set(rows.map((row) => row.createdByHrId).filter((id): id is string => Boolean(id))),
  );
  if (names.size === 0) return;

  for (const row of rows) {
    if (!row.createdByHrId) continue;
    row.createdByName = names.get(row.createdByHrId);
  }
}

const FOLDER_ITEMS_PAGE = 1000;

/**
 * Every filing, newest first, PAGED. An unbounded PostgREST select stops at 1,000 rows with no
 * marker, and past that a folder would silently lose its oldest members while those CVs reappeared
 * in the main pool (audit, 2026-09-12). `id` breaks `filed_at` ties so no page repeats or skips a row.
 */
async function readAllFolderItems(
  supabase: ReturnType<typeof recruitmentDb>,
): Promise<{ data: Array<Record<string, unknown>>; error: unknown }> {
  const data: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += FOLDER_ITEMS_PAGE) {
    const { data: page, error } = await supabase
      .from("ats_cv_folder_items")
      .select("id,folder_id,candidate_id,filed_at")
      .order("filed_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + FOLDER_ITEMS_PAGE - 1);
    if (error) return { data: [], error };
    const rows = (page ?? []) as Array<Record<string, unknown>>;
    data.push(...rows);
    if (rows.length < FOLDER_ITEMS_PAGE) return { data, error: null };
  }
}

/**
 * `readAllFolderItems`, ONCE per server render.
 *
 * The recruitment hub renders the cabinet AND the candidate pool, and the pool needs every filing
 * too (`attachCvFolderMemberships` in candidates.ts), so the same paged read ran twice per load. React
 * `cache()` hands the second caller the first one's answer; outside a render (a route handler) it is
 * a plain call. The rows are shared, so a caller must not mutate them — sort a copy.
 */
export const readAllFolderItemsOnce = cache(async () => readAllFolderItems(recruitmentDb()));

/** The whole tree and its contents. Empty — never throwing — when the migration has not landed. */
export async function loadCvFolderCabinet(options: { withNames?: boolean } = {}): Promise<CvFolderCabinet> {
  const supabase = recruitmentDb();
  const empty: CvFolderCabinet = { filedCandidateIds: new Set(), members: new Map(), rows: [] };

  const [foldersResult, itemsResult] = await Promise.all([
    supabase.from("ats_cv_folders").select("id,parent_id,name,created_at,created_by_hr_id"),
    // The paged reader, shared with the pool for the render (see readAllFolderItemsOnce).
    readAllFolderItemsOnce(),
  ]);

  if (foldersResult.error) {
    if (isMissingTable(foldersResult.error)) return empty;
    throw foldersResult.error;
  }
  // The items table failing on its own is survivable and the folders are not: show the tree with
  // nothing in it rather than nothing at all. It cannot hide a CV either — an unreadable membership
  // set means `filedCandidateIds` is empty, so every candidate stays in the pool, which is the
  // direction that loses nobody.
  const itemRows = itemsResult.error ? [] : itemsResult.data;

  const rows = ((foldersResult.data ?? []) as Array<Record<string, unknown>>).map(mapFolderRow);
  const members = new Map<string, string[]>();
  const filedCandidateIds = new Set<string>();
  for (const row of itemRows) {
    const folderId = String(row.folder_id ?? "");
    const candidateId = String(row.candidate_id ?? "");
    if (!folderId || !candidateId) continue;
    const bucket = members.get(folderId) ?? [];
    bucket.push(candidateId);
    members.set(folderId, bucket);
    filedCandidateIds.add(candidateId);
  }

  if (options.withNames !== false) await attachFolderCreatorNames(rows);
  return { filedCandidateIds, members, rows };
}

/** Just the rows, for a write path that needs to judge a change and nothing else. */
async function readFolderRows(): Promise<CvFolderRow[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_cv_folders")
    .select("id,parent_id,name,created_at,created_by_hr_id");
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapFolderRow);
}

/**
 * A refusal a recruiter is meant to READ.
 *
 * Thrown as a plain Error because that is what `recruitmentApiError` in the route layer already
 * knows how to turn into a 400/404/409 with the message intact — a bespoke error class here would
 * arrive at the browser as "Request failed."
 */
function refuse(message: string): never {
  throw new Error(message);
}

/** Create one folder. `parentId` null makes a top-level one. */
export async function createCvFolder(
  access: AccessContext,
  input: { name: string; parentId: string | null },
): Promise<CvFolderRow> {
  const rows = await readFolderRows();
  const refusal = describeCvFolderCreateRefusal({ name: input.name, parentId: input.parentId, rows });
  if (refusal) refuse(refusal);

  const name = normalizeCvFolderName(input.name);
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_cv_folders")
    .insert({
      created_by_hr_id: hrIdForStorage(access.hrId),
      name,
      name_key: cvFolderNameKey(name),
      parent_id: input.parentId,
    })
    .select("id,parent_id,name,created_at,created_by_hr_id")
    .single();

  // The race from the header: somebody else created this name between the read and the insert.
  if (error && isUniqueViolation(error)) refuse(`There is already a folder called "${name}" here.`);
  if (error) throw error;
  return mapFolderRow(data as Record<string, unknown>);
}

/** Rename one folder. The tree keeps its shape; only the label changes. */
export async function renameCvFolder(folderId: string, name: string): Promise<CvFolderRow> {
  const rows = await readFolderRows();
  const refusal = describeCvFolderRenameRefusal({ folderId, name, rows });
  if (refusal) refuse(refusal);

  const clean = normalizeCvFolderName(name);
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_cv_folders")
    .update({ name: clean, name_key: cvFolderNameKey(clean) })
    .eq("id", folderId)
    .select("id,parent_id,name,created_at,created_by_hr_id")
    .single();

  if (error && isUniqueViolation(error)) refuse(`There is already a folder called "${clean}" here.`);
  if (error) throw error;
  return mapFolderRow(data as Record<string, unknown>);
}

/**
 * Move a folder — and everything inside it — under a different parent. `parentId` null moves it to
 * the top level.
 *
 * The subtree travels with it and nothing is rewritten: only this one row's `parent_id` changes.
 * Every descendant's path follows because a path is derived, never stored.
 */
export async function moveCvFolder(folderId: string, parentId: string | null): Promise<CvFolderRow> {
  const rows = await readFolderRows();
  const refusal = describeCvFolderMoveRefusal({ folderId, parentId, rows });
  if (refusal) refuse(refusal);

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_cv_folders")
    .update({ parent_id: parentId })
    .eq("id", folderId)
    .select("id,parent_id,name,created_at,created_by_hr_id")
    .single();

  if (error && isUniqueViolation(error)) {
    const folder = rows.find((row) => row.id === folderId);
    refuse(`There is already a folder called "${folder?.name ?? "that"}" in there.`);
  }
  if (error) throw error;
  return mapFolderRow(data as Record<string, unknown>);
}

/**
 * Delete a folder and its (empty) subfolders.
 *
 * REFUSES WHILE ANY CV IS INSIDE, anywhere in the subtree — the one rule that makes this button safe
 * to press. The foreign key cascades, so without this check deleting a folder would silently return
 * every CV under it to the pool: nobody's record is lost, but the filing work is, and it is the kind
 * of loss that is noticed weeks later when a folder somebody built is simply not there. Emptying is
 * a separate, explicit action with its own confirmation.
 *
 * The count comes back in the refusal, because "it still has CVs in it" leaves the recruiter opening
 * subfolders one at a time to find out which.
 */
export async function deleteCvFolder(folderId: string): Promise<{ deletedFolderIds: string[] }> {
  const rows = await readFolderRows();
  const folder = rows.find((row) => row.id === folderId);
  if (!folder) refuse("That folder no longer exists — reload and try again.");

  const subtreeIds = collectCvFolderSubtreeIds(rows, folderId);
  const supabase = recruitmentDb();

  let held = 0;
  for (const chunk of chunkIds(subtreeIds, HR_ID_LOOKUP_CHUNK)) {
    // `count` with `head`, so this asks how many rather than fetching them — the answer is a number
    // either way and an unbounded select silently stops at 1000.
    const { count, error } = await supabase
      .from("ats_cv_folder_items")
      .select("id", { count: "exact", head: true })
      .in("folder_id", chunk);
    if (error) {
      if (isMissingTable(error)) break;
      throw error;
    }
    held += count ?? 0;
  }

  if (held > 0) {
    const where = subtreeIds.length > 1 ? " or one of its subfolders" : "";
    refuse(
      `"${folder.name}"${where} still holds ${held} CV${held === 1 ? "" : "s"}. Move them or return them to the pool first.`,
    );
  }

  // One delete: the self-referencing foreign key cascades to the (now provably empty) subfolders.
  const { error } = await supabase.from("ats_cv_folders").delete().eq("id", folderId);
  if (error) throw error;
  return { deletedFolderIds: subtreeIds };
}

/** What a push does to the CV's existing filings. */
export type CvFolderFileMode = "move" | "copy";

/**
 * Push CVs into a folder.
 *
 * `copy` adds a membership and leaves every other one alone — the same CV is then in two folders,
 * which is the thing a join table exists for.
 *
 * `move` deletes this candidate's OTHER memberships first, then adds one. Deliberately all of them
 * rather than "the one it came from": a move started from a folder screen knows its source, but a
 * move started from the pool does not, and a rule that depends on which screen you pressed it from
 * is how the same CV ends up in three folders nobody meant to put it in.
 *
 * Re-adding a CV that is already in the folder is a no-op, not an error — two people can have the
 * same folder open, and the honest answer to the second click is yes.
 */
export async function fileCandidatesInCvFolder(
  access: AccessContext,
  input: { folderId: string; candidateIds: readonly string[]; mode: CvFolderFileMode },
): Promise<{ filed: number }> {
  const candidateIds = [...new Set(input.candidateIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (candidateIds.length === 0) refuse("Pick at least one CV to file.");

  const rows = await readFolderRows();
  if (!rows.some((row) => row.id === input.folderId)) {
    refuse("That folder no longer exists — reload and try again.");
  }

  const supabase = recruitmentDb();

  if (input.mode === "move") {
    for (const chunk of chunkIds(candidateIds, HR_ID_LOOKUP_CHUNK)) {
      const { error } = await supabase
        .from("ats_cv_folder_items")
        .delete()
        .in("candidate_id", chunk)
        .neq("folder_id", input.folderId);
      if (error) throw error;
    }
  }

  const filedByHrId = hrIdForStorage(access.hrId);
  for (const chunk of chunkIds(candidateIds, HR_ID_LOOKUP_CHUNK)) {
    const { error } = await supabase.from("ats_cv_folder_items").upsert(
      chunk.map((candidateId) => ({
        candidate_id: candidateId,
        filed_by_hr_id: filedByHrId,
        folder_id: input.folderId,
      })),
      // The unique index is the conflict target, so a CV already in this folder keeps its original
      // `filed_at` and filer rather than having them rewritten by whoever clicked second.
      { ignoreDuplicates: true, onConflict: "folder_id,candidate_id" },
    );
    if (error) throw error;
  }

  return { filed: candidateIds.length };
}

/** Take CVs out of ONE folder, leaving any other filing they have alone. */
export async function removeCandidatesFromCvFolder(input: {
  folderId: string;
  candidateIds: readonly string[];
}): Promise<{ removed: number }> {
  const candidateIds = [...new Set(input.candidateIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (candidateIds.length === 0) return { removed: 0 };

  const supabase = recruitmentDb();
  for (const chunk of chunkIds(candidateIds, HR_ID_LOOKUP_CHUNK)) {
    const { error } = await supabase
      .from("ats_cv_folder_items")
      .delete()
      .eq("folder_id", input.folderId)
      .in("candidate_id", chunk);
    if (error) throw error;
  }
  return { removed: candidateIds.length };
}

/**
 * Put CVs back in the pool — out of EVERY folder, not one.
 *
 * The migration's header says why this cannot be a single-folder delete: the pool hides a candidate
 * who has at least one filing anywhere, so a copy made last month would keep somebody hidden after
 * they were explicitly put back, and the screen would say they had returned while the pool went on
 * not showing them.
 */
export async function returnCandidatesToPoolFromCvFolders(
  candidateIds: readonly string[],
): Promise<{ returned: number }> {
  const ids = [...new Set(candidateIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) return { returned: 0 };

  const supabase = recruitmentDb();
  for (const chunk of chunkIds(ids, HR_ID_LOOKUP_CHUNK)) {
    const { error } = await supabase.from("ats_cv_folder_items").delete().in("candidate_id", chunk);
    if (error) throw error;
  }
  return { returned: ids.length };
}
