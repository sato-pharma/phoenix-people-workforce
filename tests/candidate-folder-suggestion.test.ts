import assert from "node:assert/strict";

import {
  collectSuggestedFilings,
  suggestFolderFromDeclaredAnswers,
} from "../src/lib/recruitment/candidate-folder-suggestion.ts";
import { partitionCandidatesByFolder } from "../src/lib/recruitment/candidate-folder.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

/**
 * "Candidates who applied via WhatsApp ... they were asked about the region and job title and area.
 *  So now we are confident hundred percent which folder those candidates should go to. Let's start
 *  with those."
 *
 * The owner, 2026-08-30. He is right, and the whole risk sits in one word: WHICH candidates.
 *
 * THE TRAP, measured against production the same morning. `applied_for_job_title` is filled on 82
 * candidates. 64 of those were written by the CV EXTRACTOR reading a CV or a covering message; only
 * 18 were written because a person tapped a menu row. The column that looks like the answer is a
 * machine's guess three times in four, and the guesses include a bare Arabic job title and several
 * sentences lifted off a CV. Filing on it would move 64 people into folders nobody chose.
 *
 * So the properties below are all one property, asked five ways: A SUGGESTION MAY ONLY EVER COME
 * FROM `preferencesDeclaredAt`. That column is written by `writeClassification` when a WhatsApp
 * conversation completes, and it is the only field in the record meaning *the applicant said this*.
 *
 * The rest hold the shelf rules the owner set: reps by area, district managers by region, everything
 * else by job title — and a rejected CV is never shelved, in the folder module's own words rather
 * than a second copy of them.
 */

/** A candidate carrying only the six fields the suggestion reads. */
function declared(
  id: string,
  fields: {
    title?: string | null;
    area?: string | null;
    regionCode?: string | null;
    declaredAt?: string | null;
    status?: string;
    folder?: { kind: string; key: string; filedAt: string; filedByHrId: string | null } | null;
  },
): Candidate {
  return {
    id,
    fullName: id,
    status: fields.status ?? "new",
    appliedForJobTitle: fields.title ?? null,
    preferredAreaName: fields.area ?? null,
    preferredRegionCode: fields.regionCode ?? null,
    preferencesDeclaredAt: fields.declaredAt === undefined ? "2026-08-30T06:00:00Z" : fields.declaredAt,
    folder: fields.folder ?? null,
  } as unknown as Candidate;
}

export async function runCandidateFolderSuggestionTests() {
  // ── 1 · THE GATE — an extracted title is not an answer ────────────────────
  // This is the assertion the feature exists to satisfy. Both rows below carry the identical job
  // title and the identical area; they differ only in whether a human tapped it.
  const tapped = declared("tapped", { title: "Medical Representative", area: "Alex West" });
  const extracted = declared("extracted", {
    title: "Medical Representative",
    area: "Alex West",
    declaredAt: null,
  });

  assert.equal(
    suggestFolderFromDeclaredAnswers(tapped).suggestion?.key,
    "Alex West",
    "a tapped answer names its folder",
  );
  assert.equal(
    suggestFolderFromDeclaredAnswers(extracted).suggestion,
    null,
    "an EXTRACTED title must never produce a filing — 64 of production's 82 titles are extractor output",
  );
  assert.match(
    String(suggestFolderFromDeclaredAnswers(extracted).refusal),
    /extractor/i,
    "and the refusal must say why, or the next reader concludes the data is missing rather than untrusted",
  );

  // ── 2 · Medical reps file by AREA ─────────────────────────────────────────
  const rep = suggestFolderFromDeclaredAnswers(
    declared("rep", { title: "Medical Representative", area: "Gharbia 1 (Tanta)", regionCode: "D1" }),
  );
  assert.equal(rep.suggestion?.kind, "medical_rep");
  assert.equal(rep.suggestion?.key, "Gharbia 1 (Tanta)", "the AREA is the key, never the region");
  assert.equal(rep.suggestion?.label, "Gharbia 1 (Tanta)");

  // A rep who never reached the area question has no folder — and must NOT be quietly parked on the
  // "other" shelf under "Medical Representative", which would file a rep away from every other rep.
  // One real production row is exactly this shape.
  const repNoArea = suggestFolderFromDeclaredAnswers(
    declared("repNoArea", { title: "Medical Representative", area: null }),
  );
  assert.equal(repNoArea.suggestion, null, "a rep with no area cannot be filed");
  assert.match(String(repNoArea.refusal), /area/i);

  // ── 3 · District managers file by REGION CODE, shown as the region's name ──
  const dm = suggestFolderFromDeclaredAnswers(
    declared("dm", { title: "District Manager", regionCode: "D3" }),
  );
  assert.equal(dm.suggestion?.kind, "district_manager");
  assert.equal(dm.suggestion?.key, "D3", "the CODE is stored — it is the stable half");
  assert.equal(dm.suggestion?.label, "Delta (3)", "and the company's own wording is what a person reads");

  // Someone who chose "Other" and typed their region left WORDS, not a code. Words in a code column
  // is the shape that produced undefined label lookups in production on 2026-08-24.
  const dmTyped = suggestFolderFromDeclaredAnswers(
    declared("dmTyped", { title: "District Manager", regionCode: null }),
  );
  assert.equal(dmTyped.suggestion, null, "a typed region is not a region code and must not be filed as one");

  const dmUnknown = suggestFolderFromDeclaredAnswers(
    declared("dmUnknown", { title: "District Manager", regionCode: "ZZ" }),
  );
  assert.equal(dmUnknown.suggestion, null, "a region the company no longer lists cannot open a folder");
  assert.match(String(dmUnknown.refusal), /ZZ/, "and the refusal names it, so the reader can act");

  // ── 4 · Everything else files by JOB TITLE — the owner's own split ────────
  const other = suggestFolderFromDeclaredAnswers(
    declared("other", { title: "Regulatory Affairs Specialist" }),
  );
  assert.equal(other.suggestion?.kind, "other");
  assert.equal(other.suggestion?.key, "Regulatory Affairs Specialist");

  // A tapped family label wins over inference. "Human Resources" is a family LABEL, and must land on
  // the other shelf under those exact words rather than being re-inferred into something else.
  const hr = suggestFolderFromDeclaredAnswers(declared("hr", { title: "Human Resources" }));
  assert.equal(hr.suggestion?.kind, "other");
  assert.equal(hr.suggestion?.key, "Human Resources");

  // ── 5 · A rejected CV is never shelved, in the folder module's OWN words ──
  const rejected = suggestFolderFromDeclaredAnswers(
    declared("rejected", { title: "Medical Representative", area: "Alex Center", status: "rejected" }),
  );
  assert.equal(rejected.suggestion, null, "two of production's 17 placeable rows are rejected");
  assert.match(
    String(rejected.refusal),
    /rejected CV cannot be filed/i,
    "the sentence must come from candidateFolderRefusal, not a second wording that can drift from it",
  );

  // ── 6 · An already-filed CV is not suggested again ────────────────────────
  const already = suggestFolderFromDeclaredAnswers(
    declared("already", {
      title: "Medical Representative",
      area: "Alex West",
      folder: { kind: "medical_rep", key: "Alex West", filedAt: "2026-08-30T05:00:00Z", filedByHrId: "B-10" },
    }),
  );
  assert.equal(already.suggestion, null, "filing twice would be a no-op that reads as new work");

  // ── 7 · The collection: what a screen shows, and what it must NOT bury ────
  const pool: Candidate[] = [
    declared("a", { title: "Medical Representative", area: "Gharbia 1 (Tanta)" }),
    declared("b", { title: "Medical Representative", area: "Gharbia 1 (Tanta)" }),
    declared("c", { title: "District Manager", regionCode: "AB" }),
    declared("d", { title: "Medical Representative", area: null }), // answered, unplaceable
    declared("e", { title: "Medical Representative", area: "Alex Center", status: "rejected" }),
    declared("f", { title: "Medical Representative", area: "Alex West", declaredAt: null }), // extracted
    declared("g", { title: null, declaredAt: null }), // never answered anything
  ];
  const collected = collectSuggestedFilings(pool);

  assert.deepEqual(
    collected.filings.map((filing) => filing.candidateId).sort(),
    ["a", "b", "c"],
    "only the three whose own answers reach a folder",
  );
  assert.deepEqual(
    collected.skipped.map((row) => row.candidateId).sort(),
    ["d", "e"],
    "answered-but-unplaceable is SHOWN — those are the people a silent screen would lose",
  );
  assert.ok(
    !collected.skipped.some((row) => row.candidateId === "f" || row.candidateId === "g"),
    "never-answered is NOT listed as skipped — that is most of the pool and would bury d and e",
  );

  // ── 8 · The round trip: a suggestion lands in the folder it named ─────────
  // The one property that spans both modules. A suggestion that reads well but files somewhere else
  // is worse than no suggestion, and nothing else in this suite would catch it.
  const filedFromSuggestions = collected.filings.map((filing) =>
    declared(filing.candidateId, {
      title: "x",
      folder: {
        kind: filing.suggestion.kind,
        key: filing.suggestion.key,
        filedAt: "2026-08-30T06:30:00Z",
        filedByHrId: "B-10",
      },
    }),
  );
  const { pool: leftInPool, shelves, filedCount } = partitionCandidatesByFolder(filedFromSuggestions);

  assert.equal(filedCount, 3, "every suggestion must actually file — none may fall back to the pool");
  assert.equal(leftInPool.length, 0, "and none may be left where the owner said they must not appear");

  const repShelf = shelves.find((shelf) => shelf.kind === "medical_rep");
  assert.equal(repShelf?.folders.length, 1, "the two Tanta reps share ONE folder");
  assert.equal(repShelf?.folders[0]?.label, "Gharbia 1 (Tanta)");
  assert.equal(repShelf?.folders[0]?.candidates.length, 2);

  const dmShelf = shelves.find((shelf) => shelf.kind === "district_manager");
  assert.equal(dmShelf?.folders[0]?.label, "Alex-BHR", "the code files, the company's own name displays");

  // ── 9 · Nothing is suggested for a candidate that is not there ────────────
  assert.equal(suggestFolderFromDeclaredAnswers(null).suggestion, null);
  assert.equal(collectSuggestedFilings([]).filings.length, 0);
}
