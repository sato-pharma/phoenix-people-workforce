import assert from "node:assert/strict";

import {
  buildCvFolderTree,
  collectCvFolderSubtreeIds,
  cvFolderAncestry,
  cvFolderDepth,
  cvFolderNameKey,
  cvFoldersHoldingCandidate,
  describeCvFolderCreateRefusal,
  describeCvFolderMoveRefusal,
  describeCvFolderNameRefusal,
  describeCvFolderRenameRefusal,
  flattenCvFolderTree,
  MAX_CV_FOLDER_DEPTH,
  normalizeCvFolderName,
  type CvFolderRow,
} from "../src/lib/recruitment/cv-folder-tree.ts";
import { isFiledCandidate, partitionCandidatesByFolder } from "../src/lib/recruitment/candidate-folder.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

/**
 * "in /recruitment i want 2 be able to do a folder and subfolder and push cvs their and move them
 *  copy or paste to another folder" — the owner, 2026-09-12.
 *
 * He was asked the three questions the request does not answer and said: a CV pushed into one of his
 * folders DISAPPEARS from the pool, the tree is ONE shared tree for the recruitment team, and it is
 * in-app only for now (the Drive cabinet is untouched).
 *
 * Five properties this file holds still.
 *
 * THE TREE CANNOT EAT ITSELF. Moving a folder into its own descendant detaches the whole subtree: the
 * rows survive, the foreign keys resolve, and no screen can reach one of them again. It is the only
 * operation here that loses somebody's filing work without an error, so it is refused.
 *
 * A COUNT IS PEOPLE, NOT ROWS. Copy is a first-class action, so the same person legitimately sits in
 * a parent and its child. A folder heading that adds those up reports 12 CVs where there are 11
 * people, and the number he acts on is how many people are in there.
 *
 * FILED IS FILED, WHICHEVER MECHANISM DID IT. The pool, the screening queue, the CV database and the
 * folder suggestions all ask `isFiledCandidate`. Membership of a hand-built folder has to answer
 * there too, or the pool and this screen disagree about who is hidden.
 *
 * A REFUSAL IS A SENTENCE. Every one of these is shown to a recruiter mid-action; "invalid folder
 * name" tells him nothing about which of four rules he broke.
 *
 * AN ORPHAN IS SHOWN, NOT DROPPED. The safe failure for "I cannot tell where this folder belongs" is
 * a folder a human can see and move — never one that quietly takes its CVs off every screen.
 */

/** One folder row, with only the fields the pure module reads. */
function folder(id: string, name: string, parentId: string | null = null): CvFolderRow {
  return { createdAt: "2026-09-12T09:00:00.000Z", createdByHrId: "B-10", id, name, parentId };
}

/** A chain of folders `depth` deep, ids `f1`…`fN`. */
function chain(depth: number): CvFolderRow[] {
  return Array.from({ length: depth }, (_, index) =>
    folder(`f${index + 1}`, `Level ${index + 1}`, index === 0 ? null : `f${index}`),
  );
}

/** A candidate carrying only what the pool partition reads. */
function candidate(id: string, cvFolderIds: string[] = []): Candidate {
  return { cvFolderIds, folder: null, fullName: id, id, status: "new" } as unknown as Candidate;
}

export async function runCvFolderTreeTests() {
  // ── 1 · A name is normalized before anything else looks at it ────────────────────────────────
  //
  // "Alex   Team " and "Alex Team" must not both exist and read as one folder duplicated — that is
  // the owner's own complaint about the old Drive tree ("many the same folder") reproduced inside
  // the feature built to fix it.
  assert.equal(normalizeCvFolderName("  Alex   Team \n"), "Alex Team");
  assert.equal(normalizeCvFolderName(null), "");
  // Built from char codes rather than typed: a literal NUL in a .ts file makes the SOURCE binary,
  // which is a different problem from the one this line is about.
  const pastedOutOfWord = `Alex${String.fromCharCode(0)} Team${String.fromCharCode(127)}`;
  assert.equal(
    normalizeCvFolderName(pastedOutOfWord),
    "Alex Team",
    "control characters are stripped, not refused — they arrive from a paste out of Word",
  );
  assert.equal(cvFolderNameKey(" ALEX   team "), "alex team", "case and spacing cannot make two folders");

  // ── 2 · Every refusal is a sentence naming the rule that was broken ──────────────────────────
  assert.equal(describeCvFolderNameRefusal("Alex Team"), null);
  assert.match(String(describeCvFolderNameRefusal("   ")), /needs a name/);
  assert.match(String(describeCvFolderNameRefusal("x".repeat(121))), /under 120 characters/);
  for (const bad of ["Alex/Team", "Alex\\Team"]) {
    assert.match(
      String(describeCvFolderNameRefusal(bad)),
      /make a subfolder instead/,
      "a name is one folder, never a path — and the refusal says what to do instead",
    );
  }

  // ── 3 · Depth is capped, and the cap is counted from the PARENT ──────────────────────────────
  {
    const rows = chain(MAX_CV_FOLDER_DEPTH);
    assert.equal(cvFolderDepth(rows, null), 0, "no folder is depth 0, so parent+1 needs no special case");
    assert.equal(cvFolderDepth(rows, "f1"), 1, "a top-level folder is depth 1");
    assert.equal(cvFolderDepth(rows, `f${MAX_CV_FOLDER_DEPTH}`), MAX_CV_FOLDER_DEPTH);

    assert.equal(
      describeCvFolderCreateRefusal({ name: "Deeper", parentId: `f${MAX_CV_FOLDER_DEPTH - 1}`, rows }),
      null,
      "the last legal level is allowed",
    );
    assert.match(
      String(describeCvFolderCreateRefusal({ name: "Deeper", parentId: `f${MAX_CV_FOLDER_DEPTH}`, rows })),
      new RegExp(`${MAX_CV_FOLDER_DEPTH} levels deep`),
      "one past it is refused, in words, with the limit in them",
    );
    assert.match(
      String(describeCvFolderCreateRefusal({ name: "Anywhere", parentId: "gone", rows })),
      /no longer exists/,
      "a parent deleted by somebody else is a reload, not a crash",
    );
  }

  // ── 4 · Two siblings cannot share a name; two cousins can ────────────────────────────────────
  {
    const rows = [folder("a", "Alex"), folder("b", "Cairo"), folder("a1", "Second interview", "a")];
    assert.match(
      String(describeCvFolderCreateRefusal({ name: " alex ", parentId: null, rows })),
      /already a folder called "alex" here/,
      "case and spacing do not make it a different folder",
    );
    assert.equal(
      describeCvFolderCreateRefusal({ name: "Second interview", parentId: "b", rows }),
      null,
      "…but the same name under a DIFFERENT parent is a different folder, which is the point of a tree",
    );
    assert.match(
      String(describeCvFolderRenameRefusal({ folderId: "b", name: "Alex", rows })),
      /already a folder called/,
      "a rename collides on the same rule",
    );
    assert.equal(
      describeCvFolderRenameRefusal({ folderId: "a", name: "ALEX", rows }),
      null,
      "…and a folder never collides with ITSELF — recasing your own folder is a legal rename",
    );
  }

  // ── 5 · THE MOVE THAT WOULD LOSE THE WORK ────────────────────────────────────────────────────
  //
  // Grandparent moved under its own grandchild. Every row survives, every foreign key resolves, and
  // the entire branch becomes unreachable from the root — so nothing renders it and nothing says
  // why. This is the assertion the whole module exists for.
  {
    const rows = [folder("a", "Alex"), folder("b", "Team", "a"), folder("c", "Second interview", "b")];
    assert.match(
      String(describeCvFolderMoveRefusal({ folderId: "a", parentId: "c", rows })),
      /cannot be moved inside one of its own subfolders/,
      "the silent-detach case is refused",
    );
    assert.match(
      String(describeCvFolderMoveRefusal({ folderId: "a", parentId: "a", rows })),
      /inside itself/,
    );
    assert.equal(
      describeCvFolderMoveRefusal({ folderId: "c", parentId: null, rows }),
      null,
      "moving a folder OUT to the top level is always legal — it is the way back from a bad nest",
    );
    assert.equal(
      describeCvFolderMoveRefusal({ folderId: "b", parentId: "a", rows }),
      null,
      "moving a folder where it already is is a no-op, not an error",
    );
    assert.deepEqual(collectCvFolderSubtreeIds(rows, "a"), ["a", "b", "c"]);
    assert.deepEqual(
      cvFolderAncestry(rows, "c").map((row) => row.id),
      ["c", "b", "a"],
      "the breadcrumb runs from the folder UP",
    );
  }

  // ── 6 · A move is judged on the whole SUBTREE's height, not the folder alone ─────────────────
  //
  // Moving a 3-deep branch under a folder at level 3 puts its leaves at level 5 — legal at a cap of
  // 5, and the same move one level lower is not. Checking only the moved folder's own depth passes
  // both and leaves a tree the picker cannot render.
  {
    const rows = [
      ...chain(MAX_CV_FOLDER_DEPTH - 1),
      folder("t1", "Branch"),
      folder("t2", "Branch child", "t1"),
    ];
    assert.equal(
      describeCvFolderMoveRefusal({ folderId: "t1", parentId: `f${MAX_CV_FOLDER_DEPTH - 2}`, rows }),
      null,
      "a 2-tall branch fits under level 3 when the cap is 5",
    );
    assert.match(
      String(describeCvFolderMoveRefusal({ folderId: "t1", parentId: `f${MAX_CV_FOLDER_DEPTH - 1}`, rows })),
      new RegExp(`the limit is ${MAX_CV_FOLDER_DEPTH}`),
      "…and one level lower it does not, because the CHILD is what would be too deep",
    );
  }

  // ── 7 · A parent's count is DISTINCT people, across a copy ───────────────────────────────────
  //
  // The reason the tree carries candidate ids rather than counts. "cv-9" is copied into a folder and
  // its subfolder, which is exactly what the owner asked copy to do; a parent that sums its
  // children reports 3 CVs where there are 2 people.
  {
    const rows = [folder("a", "Alex"), folder("b", "Second interview", "a"), folder("z", "Cairo")];
    const members = new Map<string, string[]>([
      ["a", ["cv-9", "cv-1"]],
      ["b", ["cv-9"]],
      ["z", []],
    ]);
    const tree = buildCvFolderTree(rows, members);
    const alex = tree.find((node) => node.id === "a")!;
    assert.equal(alex.directCount, 2);
    assert.equal(alex.totalCount, 2, "the same person copied into a child is ONE person in the parent");
    assert.equal(alex.children[0]?.totalCount, 1);
    assert.deepEqual(alex.path, ["Alex"]);
    assert.deepEqual(alex.children[0]?.path, ["Alex", "Second interview"]);
    assert.equal(alex.children[0]?.depth, 2);

    assert.deepEqual(
      tree.map((node) => node.name),
      ["Alex", "Cairo"],
      "siblings are ordered by name, so the tree does not reshuffle on every reload",
    );
    assert.deepEqual(
      flattenCvFolderTree(tree).map((node) => node.id),
      ["a", "b", "z"],
      "the picker reads depth-first, in the same order the tree draws",
    );
    assert.deepEqual(cvFoldersHoldingCandidate(members, "cv-9"), ["a", "b"]);
    assert.deepEqual(cvFoldersHoldingCandidate(members, "cv-nobody"), []);
  }

  // ── 8 · An orphan is rendered at the top, and a stored cycle does not hang the page ──────────
  {
    const orphan = buildCvFolderTree([folder("x", "Stranded", "missing-parent")], new Map());
    assert.deepEqual(
      orphan.map((node) => node.id),
      ["x"],
      "a folder whose parent is gone is SHOWN, where a human can move it — never dropped with its CVs",
    );

    // Only reachable with hand SQL — the app refuses every move that would make it — but the failure
    // without the guard is an infinite loop that hangs the whole recruitment page.
    const cyclic = [folder("p", "One", "q"), folder("q", "Two", "p")];
    assert.deepEqual(cvFolderAncestry(cyclic, "p").map((row) => row.id), ["p", "q"], "the walk stops");
    assert.equal(buildCvFolderTree(cyclic, new Map()).length >= 0, true, "and the build returns at all");
  }

  // ── 9 · A CV in a hand-built folder is OFF the pool — the owner's answer to the first question ─
  //
  // One function decides this, because the pool, the screening queue, the CV database and the folder
  // suggestions all ask it. Two filters agreeing today is how a candidate ends up in neither.
  assert.ok(isFiledCandidate(candidate("in-a-folder", ["a"])), "membership of a hand-built folder counts as filed");
  assert.ok(!isFiledCandidate(candidate("loose")), "an empty list is NOT filed — the direction that shows a person");
  assert.ok(!isFiledCandidate(null));

  {
    const split = partitionCandidatesByFolder([candidate("pooled"), candidate("filed", ["a"])]);
    assert.deepEqual(split.pool.map((row) => row.id), ["pooled"]);
    assert.deepEqual(
      split.cabinet.map((row) => row.id),
      ["filed"],
      "…and it has its own bucket, so the folders tab can show what the pool is hiding",
    );
    assert.equal(split.filedCount, 1);
    assert.equal(
      split.shelves.some((shelf) => shelf.folders.some((f) => f.candidates.some((row) => row.id === "filed"))),
      false,
      "a hand-built folder is not one of the four derived shelves",
    );
  }
}
