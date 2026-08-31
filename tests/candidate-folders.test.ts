import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  candidateFolderKey,
  candidateFolderKinds,
  candidateFolderLabel,
  candidateFolderRefusal,
  canFileCandidate,
  cleanFolderKey,
  districtManagerFolderOptions,
  isCandidateFolderKind,
  isFiledCandidate,
  PARAMEDICAL_FOLDER_KEY,
  partitionCandidatesByFolder,
} from "../src/lib/recruitment/candidate-folder.ts";
import { candidateRegionCodes } from "../src/lib/recruitment/candidate-region.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

/**
 * "In recruitment, I want to make folders for areas ... if this CV is good, but I'm not needing it
 *  now, I push the CV to the folder, and then I have every single archive ... folder for medical
 *  reps for now and folder for district manager. The district managers will be who must have six
 *  folders based on the regions. Medical reps have folders based on the areas and make other folder
 *  for any other position."
 *
 * "The CV that I push to a folder ... it is not appearing now on the main page."
 *
 * The owner, 2026-08-30. He said six regions; the company has eight, and asked directly the same day
 * he answered "8 regions, and split other positions by job title".
 *
 * Four properties this file holds still.
 *
 * A FILED CV LEAVES THE POOL, AND A POOLED CV IS NEVER ON A SHELF. This is the requirement, and the
 * only thing that makes it safe is that both halves come out of ONE partition of ONE array — two
 * independent filters is exactly how a candidate ends up in neither and is lost.
 *
 * THE REGION SHELF IS DRIVEN FROM THE COMPANY'S OWN LIST. A hand-written six would have been wrong
 * on the day it shipped (Delta (3) is live) and would drift again at the next reorganisation.
 *
 * A TYPED FOLDER AND A PICKED ONE WITH THE SAME WORDS ARE ONE FOLDER. The "other" shelf is
 * free-typed, so casing and stray whitespace are the whole risk.
 *
 * A REJECTED CV CANNOT BE FILED. The shelf is for good CVs waiting on a seat, in his words; burying
 * a rejection in an area folder means the folder somebody opens next March contains people already
 * turned down.
 */

/** A candidate carrying only what the shelf actually reads. */
function filed(
  id: string,
  folder: { kind: string; key: string; filedAt: string } | null,
  status = "new",
): Candidate {
  return {
    id,
    fullName: id,
    status,
    folder: folder ? { ...folder, filedByHrId: "B-10" } : null,
  } as unknown as Candidate;
}

export async function runCandidateFolderTests() {
  // ── 1 · The vocabulary ────────────────────────────────────────────────────
  assert.deepEqual(
    [...candidateFolderKinds],
    ["medical_rep", "district_manager", "other", "paramedical"],
    "four shelves, in the order the owner named them — paramedical last, added 2026-08-31",
  );
  assert.ok(isCandidateFolderKind("medical_rep"));
  assert.ok(!isCandidateFolderKind("regional_manager"), "an unknown shelf must not pass the guard");
  assert.ok(!isCandidateFolderKind(null));

  // ── 2 · EIGHT regions, from the company's list — not six, and not hand-written ──
  const regions = districtManagerFolderOptions();
  assert.equal(regions.length, 8, "the owner said six; the live company list is eight — this must follow the list");
  assert.deepEqual(
    regions.map((option) => option.key),
    [...candidateRegionCodes],
    "the region shelf must BE candidateRegionCodes, so a new region appears without a code change here",
  );
  assert.ok(
    regions.some((option) => option.key === "D3" && option.label === "Delta (3)"),
    "Delta (3) is live and was the region the owner had just opened — a hand-written six would have omitted it",
  );
  assert.ok(
    regions.some((option) => option.key === "OT" && option.label === "Others"),
    "Others carries areas and must be offerable, even though it carries no target",
  );

  // ── 3 · Cleaning and keying, which is what makes the free-typed shelf safe ──
  assert.equal(cleanFolderKey("  Nasr City  "), "Nasr City", "trimmed");
  assert.equal(
    cleanFolderKey("Regulatory  Affairs"),
    "Regulatory Affairs",
    "an inner double space must collapse — otherwise it opens a second folder reading like the first",
  );
  assert.equal(cleanFolderKey("   "), null, "whitespace only is not a folder name");
  assert.equal(cleanFolderKey(null), null);

  assert.equal(
    candidateFolderKey("other", "Regulatory Affairs"),
    candidateFolderKey("other", "regulatory  affairs"),
    "a typed folder and a picked one with the same words are ONE folder",
  );
  assert.equal(candidateFolderKey("district_manager", "d3"), "D3", "a region key is canonicalised upper-case");
  assert.equal(candidateFolderKey("medical_rep", "  "), null, "an empty key means not filed");

  // ── 4 · Labels — the region shelf is the only one that translates ──────────
  assert.equal(candidateFolderLabel("district_manager", "D3"), "Delta (3)", "a region CODE is shown as its name");
  assert.equal(candidateFolderLabel("medical_rep", "Nasr City"), "Nasr City", "an area is already its own name");
  assert.equal(
    candidateFolderLabel("district_manager", "ZZ"),
    "ZZ",
    "an unknown region code is shown VERBATIM — no invented value ever reaches a screen",
  );

  // ── 5 · A rejected CV cannot be filed ─────────────────────────────────────
  assert.equal(candidateFolderRefusal(filed("a", null, "new")), null, "a new CV is fileable");
  assert.equal(candidateFolderRefusal(filed("b", null, "shortlisted")), null, "so is a shortlisted one");
  const refusal = candidateFolderRefusal(filed("c", null, "rejected"));
  assert.ok(refusal && refusal.includes("rejected"), "a rejected CV is refused, with a reason to show");
  assert.ok(!canFileCandidate(filed("c", null, "rejected")));
  assert.ok(
    canFileCandidate(filed("d", null, "Candidate Created")),
    "the legacy free-text default normalises to 'new' and stays fileable — 322 of production's 476 carry it",
  );

  // ── 6 · The partition: a CV is in EXACTLY ONE of the two halves ───────────
  const candidates = [
    filed("nasr-1", { filedAt: "2026-08-30T09:00:00Z", key: "Nasr City", kind: "medical_rep" }),
    filed("nasr-2", { filedAt: "2026-08-30T11:00:00Z", key: "nasr  city", kind: "medical_rep" }),
    filed("heliopolis", { filedAt: "2026-08-30T10:00:00Z", key: "Heliopolis", kind: "medical_rep" }),
    filed("dm-d3", { filedAt: "2026-08-30T08:00:00Z", key: "D3", kind: "district_manager" }),
    filed("ra", { filedAt: "2026-08-30T07:00:00Z", key: "Regulatory Affairs", kind: "other" }),
    filed("live-1", null),
    filed("live-2", null),
  ];
  const { pool, shelves, filedCount } = partitionCandidatesByFolder(candidates);

  assert.equal(filedCount, 5, "five were filed");
  assert.deepEqual(pool.map((candidate) => candidate.id), ["live-1", "live-2"], "only the unfiled reach the pool");
  assert.equal(
    pool.length + filedCount,
    candidates.length,
    "every candidate is in exactly one half — the invariant that stops a CV being lost between the two screens",
  );

  assert.equal(
    shelves.length,
    candidateFolderKinds.length,
    "every shelf comes back, empty ones included — driven off the vocabulary so a fifth cannot silently not render",
  );
  const medicalRep = shelves.find((shelf) => shelf.kind === "medical_rep")!;
  assert.equal(medicalRep.candidateCount, 3);
  assert.deepEqual(
    medicalRep.folders.map((folder) => folder.label),
    ["Heliopolis", "Nasr City"],
    "folders read alphabetically — a filing cabinet is looked up by name, not by recency",
  );
  const nasrCity = medicalRep.folders.find((folder) => folder.label === "Nasr City")!;
  assert.equal(
    nasrCity.candidates.length,
    2,
    "'Nasr City' and 'nasr  city' are ONE folder — case and whitespace must not open a second",
  );
  assert.deepEqual(
    nasrCity.candidates.map((candidate) => candidate.id),
    ["nasr-2", "nasr-1"],
    "newest filing first inside a folder",
  );
  assert.equal(nasrCity.lastFiledAt, "2026-08-30T11:00:00Z", "the folder carries its newest filing, not its first");

  const districtManager = shelves.find((shelf) => shelf.kind === "district_manager")!;
  assert.deepEqual(districtManager.folders.map((folder) => folder.label), ["Delta (3)"], "shown by name, stored by code");
  assert.equal(districtManager.folders[0]!.storedKey, "D3", "the stored key stays the code");

  // ── 7 · An unreadable filing leaves the CV IN THE POOL, never hidden ──────
  // The database constraint makes these shapes unreachable through the app. A hand-written SQL fix
  // can still produce one, and the safe failure for "I cannot tell which folder this is" is to leave
  // the CV where a human will see it.
  const damaged = partitionCandidatesByFolder([
    filed("bad-kind", { filedAt: "2026-08-30T09:00:00Z", key: "Nasr City", kind: "regional_manager" }),
    filed("bad-key", { filedAt: "2026-08-30T09:00:00Z", key: "   ", kind: "medical_rep" }),
  ]);
  assert.deepEqual(
    damaged.pool.map((candidate) => candidate.id),
    ["bad-kind", "bad-key"],
    "a filing nothing can name must never hide the candidate",
  );
  assert.equal(damaged.filedCount, 0, "and it must not be counted as filed either");

  // ── 8 · The paramedical shelf holds ONE folder, and nothing asks for its key ──
  {
    // The owner asked for "a separate folder", singular. That is not cosmetic: this shelf exists so
    // a recruiter can see everyone the eligibility rule excluded in one place. Split per degree it
    // becomes thirty lists nobody opens.
    assert.equal(PARAMEDICAL_FOLDER_KEY, "Paramedical", "the owner named this folder himself");
    assert.equal(
      candidateFolderLabel("paramedical", PARAMEDICAL_FOLDER_KEY),
      "Paramedical",
      "the shelf's one folder shows the owner's own word — this is the heading he reads",
    );

    const shelf = partitionCandidatesByFolder([
      filed("p1", { filedAt: "2026-08-31T09:00:00Z", key: PARAMEDICAL_FOLDER_KEY, kind: "paramedical" }),
      // A hand-written SQL fix, or an older writer, could spell it differently. Case-insensitive
      // grouping means that renames the folder rather than splitting it — which is the failure worth
      // knowing about, and the reason every writer goes through the constant.
      filed("p2", { filedAt: "2026-08-31T10:00:00Z", key: "paramedical", kind: "paramedical" }),
    ]).shelves.find((entry) => entry.kind === "paramedical")!;
    assert.equal(shelf.folders.length, 1, "one shelf, one folder — two spellings must not open a second");
    assert.equal(shelf.candidateCount, 2);

    // The recruiter's picker. Source-pinned because rendering it needs React and a candidate row.
    // Before this branch existed the else-branch ran for paramedical, which offered a recruiter the
    // list of AREAS, grouped by region, under the prompt for a degree.
    const workspace = readFileSync(
      fileURLToPath(new URL("../src/components/recruitment/recruitment-workspace.tsx", import.meta.url)),
      "utf8",
    );
    assert.match(
      workspace,
      /kind === "paramedical" \? \(/,
      "the picker must special-case the one shelf with nothing to choose, before it reaches the area select",
    );
    assert.match(
      workspace,
      /setKey\(next === "paramedical" \? PARAMEDICAL_FOLDER_KEY : ""\)/,
      "…and set its key itself — the File button is disabled on an empty key, so an unasked key files nothing",
    );
  }

  // ── 9 · isFiledCandidate is the one authority every screen asks ───────────
  assert.ok(isFiledCandidate(filed("x", { filedAt: "2026-08-30T09:00:00Z", key: "Nasr City", kind: "medical_rep" })));
  assert.ok(!isFiledCandidate(filed("y", null)));
  assert.ok(!isFiledCandidate(null));
}
