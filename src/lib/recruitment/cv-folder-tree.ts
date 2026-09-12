// Recruitment / ATS — what a legal CV folder tree is, decided in one place.
//
// The owner asked on 2026-09-12 for "a folder and subfolder ... push cvs their and move them copy
// or paste to another folder". This module owns every rule about the SHAPE of that tree: what a
// folder may be called, how deep it may go, which moves are legal, and how many CVs a folder really
// holds once its subfolders are counted.
//
// PURE — no database, no network, no React. The folder screen is a "use client" component, so a
// database import anywhere in this chain would drag the service-role client into the browser
// bundle. Same constraint candidate-folder.ts, red-flag.ts and position-folder.ts are written
// under, and the reason the whole tree is expressible as a function of the rows.
//
// ── WHY THE RULES ARE HERE AND NOT IN SQL ───────────────────────────────────────────────────────
//
// Depth and cycles are the two rules Postgres cannot express without a recursive trigger, and a
// trigger would be a SECOND place that knows what a legal tree is. The migration says so in its own
// header. Since those two have to live in code, every other rule lives beside them rather than being
// split across two files that can disagree — the route asks this module and then writes.
//
// The database still carries the rules it CAN hold honestly: a name that is blank, over-long,
// carries a path separator, or duplicates a sibling is refused by a constraint or a unique index as
// well as here. That duplication is deliberate and is the same pattern the shelf uses: validating at
// the boundary turns a bad value into a sentence a recruiter can read instead of a 500 from Postgres,
// while the constraint is what stops hand-written SQL producing a shape no screen can render.

/**
 * How deep the tree may go, counting a top-level folder as 1.
 *
 * Not a database rule (see the header). Five is a judgement rather than a measurement: the owner
 * asked for "a folder and subfolder", which is two, and the cabinet tree Drive already files into is
 * three deep (Position / Region / Area). Five leaves room to mirror that and nest twice more inside
 * it, and stops a tree from growing a path no sidebar can render and nobody can navigate back out
 * of. Raising it is a one-line change with no migration.
 */
export const MAX_CV_FOLDER_DEPTH = 5;

/** Long enough for the longest real job title, short enough to read in a tree. Matches the shelf. */
export const CV_FOLDER_NAME_MAX_LENGTH = 120;

/** One folder as it comes out of the database. */
export type CvFolderRow = {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  createdByHrId: string | null;
  /** The creator's display name, resolved against `employees`. Names, never raw HR ids. */
  createdByName?: string | null;
};

/** One folder as a screen renders it — the row, plus everything derivable from the whole set. */
export type CvFolderNode = CvFolderRow & {
  /** 1 for a top-level folder. */
  depth: number;
  /** The names from the top down, this folder last — what a breadcrumb prints. */
  path: string[];
  children: CvFolderNode[];
  /** CVs filed in THIS folder. */
  directCount: number;
  /**
   * DISTINCT candidates in this folder and every folder beneath it.
   *
   * Distinct, not a sum, and that is the whole reason the tree is built from candidate IDS rather
   * than from counts. Copy is a first-class action here, so the same person legitimately sits in a
   * parent and its child — and a heading that adds those two up tells a recruiter he has 12 CVs
   * where he has 11 people. The one number he acts on is how many people are in there.
   */
  totalCount: number;
  /**
   * The distinct candidate ids `totalCount` counts, this folder and every folder beneath it.
   *
   * Carried on the node rather than recomputed because the distinct roll-up needs the ids, not the
   * counts — a parent cannot add up its children's numbers when the same person may sit in two of
   * them. Also what lets a screen answer "is this CV already in here?" without a second query.
   */
  candidateIds: string[];
};

/**
 * A folder name, as it will be stored.
 *
 * Collapses runs of whitespace and trims, so "Alex   Team " and "Alex Team" cannot both exist and
 * read as one folder duplicated. Control characters are stripped rather than refused: they arrive
 * from a paste out of Word far more often than from anyone meaning anything by them, and a name that
 * is merely invisible is worse than one that is quietly cleaned.
 */
export function normalizeCvFolderName(value: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * The uniqueness key for a name — what the database's partial unique indexes are written on.
 *
 * Lower-cased, on the normalized form. Two siblings cannot differ only in case or spacing, because
 * "Alex Team" beside "alex team" is the owner's own complaint about the old Drive tree ("many the
 * same folder") reproduced in a feature built to fix it.
 */
export function cvFolderNameKey(value: string | null | undefined): string {
  return normalizeCvFolderName(value).toLowerCase();
}

/**
 * Why this name cannot be used, as a sentence — or null when it can.
 *
 * Returns WORDS rather than a boolean throughout this module. Every one of these refusals is shown
 * to a recruiter mid-action, and "invalid folder name" tells him nothing about which of four rules
 * he broke.
 */
export function describeCvFolderNameRefusal(value: string | null | undefined): string | null {
  const name = normalizeCvFolderName(value);
  if (!name) return "A folder needs a name.";
  if (name.length > CV_FOLDER_NAME_MAX_LENGTH) {
    return `Keep the folder name under ${CV_FOLDER_NAME_MAX_LENGTH} characters.`;
  }
  // A name is one folder, never a path. Checked here as well as by the CHECK constraint so the
  // recruiter is told which character is the problem instead of seeing a database error.
  if (/[/\\]/.test(name)) return "A folder name cannot contain / or \\ — make a subfolder instead.";
  return null;
}

/** Index the rows by id once, so every walk below is a lookup rather than a scan. */
function indexRows(rows: readonly CvFolderRow[]): Map<string, CvFolderRow> {
  const byId = new Map<string, CvFolderRow>();
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

/**
 * The chain from a folder up to the top, that folder first.
 *
 * Guarded against a cycle with a `seen` set, and NOT because the app can make one — it refuses every
 * move that would (see `describeCvFolderMoveRefusal`) and the migration refuses the one-row case in
 * SQL. It is guarded because this function runs on data read from a database a person can reach with
 * hand SQL, and the failure mode without the guard is an infinite loop that hangs the whole
 * recruitment page rather than an error anybody can read.
 */
export function cvFolderAncestry(
  rows: readonly CvFolderRow[],
  folderId: string | null | undefined,
): CvFolderRow[] {
  const byId = indexRows(rows);
  const chain: CvFolderRow[] = [];
  const seen = new Set<string>();
  let current = folderId ? byId.get(folderId) ?? null : null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) ?? null : null;
  }
  return chain;
}

/**
 * How deep a folder sits — 1 for a top-level one, 0 for "no folder" (the root of the tree).
 *
 * Passing null answers 0, which is what makes `depthOf(parentId) + 1` the depth of a new child
 * without a special case for a top-level folder.
 */
export function cvFolderDepth(rows: readonly CvFolderRow[], folderId: string | null | undefined): number {
  return folderId ? cvFolderAncestry(rows, folderId).length : 0;
}

/**
 * A folder and every folder beneath it, the folder itself first.
 *
 * This is what a move has to refuse moving INTO, and what a delete has to prove is empty.
 */
export function collectCvFolderSubtreeIds(rows: readonly CvFolderRow[], folderId: string): string[] {
  const childrenOf = new Map<string | null, CvFolderRow[]>();
  for (const row of rows) {
    const bucket = childrenOf.get(row.parentId) ?? [];
    bucket.push(row);
    childrenOf.set(row.parentId, bucket);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  const queue = [folderId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    for (const child of childrenOf.get(id) ?? []) queue.push(child.id);
  }
  return ids;
}

/** How tall the subtree under a folder is — 1 when it has no children. */
function subtreeHeight(rows: readonly CvFolderRow[], folderId: string): number {
  const depthOfRoot = cvFolderDepth(rows, folderId);
  let tallest = 1;
  for (const id of collectCvFolderSubtreeIds(rows, folderId)) {
    tallest = Math.max(tallest, cvFolderDepth(rows, id) - depthOfRoot + 1);
  }
  return tallest;
}

/** Does a folder with this name already sit under this parent? `ignoreId` skips a rename's own row. */
function siblingNameTaken(
  rows: readonly CvFolderRow[],
  parentId: string | null,
  name: string,
  ignoreId?: string | null,
): boolean {
  const key = cvFolderNameKey(name);
  return rows.some(
    (row) => row.parentId === (parentId ?? null) && row.id !== ignoreId && cvFolderNameKey(row.name) === key,
  );
}

/** Why a new folder cannot be created here, as a sentence — or null when it can. */
export function describeCvFolderCreateRefusal(input: {
  rows: readonly CvFolderRow[];
  parentId: string | null;
  name: string | null | undefined;
}): string | null {
  const nameRefusal = describeCvFolderNameRefusal(input.name);
  if (nameRefusal) return nameRefusal;

  if (input.parentId) {
    const parent = input.rows.find((row) => row.id === input.parentId);
    if (!parent) return "That folder no longer exists — reload and try again.";
    const depth = cvFolderDepth(input.rows, input.parentId) + 1;
    if (depth > MAX_CV_FOLDER_DEPTH) {
      return `Folders go ${MAX_CV_FOLDER_DEPTH} levels deep. Put this one higher up, or file the CVs here instead.`;
    }
  }

  if (siblingNameTaken(input.rows, input.parentId, String(input.name ?? ""))) {
    return `There is already a folder called "${normalizeCvFolderName(input.name)}" here.`;
  }
  return null;
}

/** Why a folder cannot be renamed to this, as a sentence — or null when it can. */
export function describeCvFolderRenameRefusal(input: {
  rows: readonly CvFolderRow[];
  folderId: string;
  name: string | null | undefined;
}): string | null {
  const nameRefusal = describeCvFolderNameRefusal(input.name);
  if (nameRefusal) return nameRefusal;

  const folder = input.rows.find((row) => row.id === input.folderId);
  if (!folder) return "That folder no longer exists — reload and try again.";

  if (siblingNameTaken(input.rows, folder.parentId, String(input.name ?? ""), folder.id)) {
    return `There is already a folder called "${normalizeCvFolderName(input.name)}" here.`;
  }
  return null;
}

/**
 * Why a folder cannot be moved under this parent, as a sentence — or null when it can.
 *
 * FOUR REFUSALS, AND THE SECOND IS THE ONE THAT MATTERS. Moving a folder into its own descendant
 * detaches the whole subtree from the root: every row still exists, every foreign key still resolves,
 * and nothing on any screen can reach a single one of them again. It is the one operation here that
 * loses filing work silently, so it is refused on the full row set rather than on the parent alone.
 */
export function describeCvFolderMoveRefusal(input: {
  rows: readonly CvFolderRow[];
  folderId: string;
  parentId: string | null;
}): string | null {
  const folder = input.rows.find((row) => row.id === input.folderId);
  if (!folder) return "That folder no longer exists — reload and try again.";

  const parentId = input.parentId ?? null;
  if (parentId === folder.parentId) return null; // Already there. Not an error, and not a write.

  if (parentId === folder.id) return "A folder cannot be moved inside itself.";

  if (parentId) {
    const parent = input.rows.find((row) => row.id === parentId);
    if (!parent) return "That destination folder no longer exists — reload and try again.";

    const subtree = new Set(collectCvFolderSubtreeIds(input.rows, folder.id));
    if (subtree.has(parentId)) {
      return `"${folder.name}" cannot be moved inside one of its own subfolders.`;
    }

    const newDepth = cvFolderDepth(input.rows, parentId) + subtreeHeight(input.rows, folder.id);
    if (newDepth > MAX_CV_FOLDER_DEPTH) {
      return `That would put folders ${newDepth} levels deep, and the limit is ${MAX_CV_FOLDER_DEPTH}.`;
    }
  }

  if (siblingNameTaken(input.rows, parentId, folder.name, folder.id)) {
    return `There is already a folder called "${folder.name}" in there.`;
  }
  return null;
}

/**
 * Build the renderable tree from the rows and who is in each folder.
 *
 * `members` maps a folder id to the candidate ids filed in it. Candidate IDS rather than counts,
 * because `totalCount` is a DISTINCT count across the subtree and a sum cannot produce one — see the
 * field's own note.
 *
 * ORPHANS ARE SHOWN, NOT DROPPED. A row whose `parentId` names a folder that is not in the set is
 * rendered at the top level rather than skipped. The foreign key makes that shape unreachable
 * through the app, but the safe failure for "I cannot tell where this folder belongs" is a folder a
 * human can see and move, not one that silently takes its CVs out of every screen at once. Same
 * reasoning as the unknown-kind fallback in `partitionCandidatesByFolder`.
 */
export function buildCvFolderTree(
  rows: readonly CvFolderRow[],
  members: ReadonlyMap<string, readonly string[]>,
): CvFolderNode[] {
  const byId = indexRows(rows);
  const childrenOf = new Map<string | null, CvFolderRow[]>();
  for (const row of rows) {
    // An unresolvable parent is treated as no parent — the orphan rule above.
    const parentId = row.parentId && byId.has(row.parentId) ? row.parentId : null;
    const bucket = childrenOf.get(parentId) ?? [];
    bucket.push(row);
    childrenOf.set(parentId, bucket);
  }
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  const guard = new Set<string>();

  function build(row: CvFolderRow, depth: number, parentPath: readonly string[]): CvFolderNode {
    guard.add(row.id);
    const path = [...parentPath, row.name];
    const direct = members.get(row.id) ?? [];
    const children = (childrenOf.get(row.id) ?? [])
      .filter((child) => !guard.has(child.id))
      .map((child) => build(child, depth + 1, path));

    // Distinct across the subtree: seed with this folder's own, then fold every child's in. The
    // children have already done the same, so this is one pass over the tree rather than one per
    // node — but a child's `totalCount` cannot simply be added, so the ids travel too.
    const distinct = new Set<string>(direct);
    for (const child of children) for (const id of child.candidateIds) distinct.add(id);

    return {
      ...row,
      candidateIds: [...distinct],
      children,
      depth,
      directCount: direct.length,
      path,
      totalCount: distinct.size,
    };
  }

  return (childrenOf.get(null) ?? []).map((row) => build(row, 1, []));
}

/**
 * The tree as a flat, depth-first list — what a "move to…" picker renders.
 *
 * Depth-first and in the same order the tree draws, so an indented picker reads as the same shape
 * the recruiter is looking at rather than as an alphabetical list of unrelated names.
 */
export function flattenCvFolderTree(nodes: readonly CvFolderNode[]): CvFolderNode[] {
  const out: CvFolderNode[] = [];
  for (const node of nodes) {
    out.push(node);
    out.push(...flattenCvFolderTree(node.children));
  }
  return out;
}

/** The folder ids a CV is currently in, from the same member map the tree is built from. */
export function cvFoldersHoldingCandidate(
  members: ReadonlyMap<string, readonly string[]>,
  candidateId: string,
): string[] {
  const ids: string[] = [];
  for (const [folderId, candidateIds] of members) {
    if (candidateIds.includes(candidateId)) ids.push(folderId);
  }
  return ids;
}
