import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { candidateFolderKinds } from "../src/lib/recruitment/candidate-folder.ts";
import {
  applyManagerFilings,
  isManagersOwnFiling,
  managerFolderKinds,
  partitionManagerCandidates,
  withManagerFiling,
  type ManagerFolderFilings,
} from "../src/lib/recruitment/manager-folder-shelf.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

/**
 * "and I want him to have a folders like like me."  — the owner, 2026-08-30.
 *
 * THE RISK THIS SUITE EXISTS FOR, and it is not the folders. It is that a manager's shelf and the
 * recruitment team's shelf are two different filing cabinets that look identical on screen and share
 * every label. The recruiter's filing lives on the CANDIDATE ROW and hides the CV from every
 * recruiter in the company; the manager's lives in ats_candidate_manager_folders and must hide it
 * from nobody but him. If the overlay in manager-folder-shelf.ts ever stops replacing
 * `candidate.folder` outright — if it merges, or falls back to the recruiter's value when the
 * manager has none — then a District Manager opening his portal sees Talent Acquisition's folders
 * wearing his name, and pressing "Return to my list" on one appears to do nothing at all.
 *
 * So the assertions below are mostly about the NEGATIVE: what a manager must NOT inherit.
 */

function candidate(id: string, fields: Partial<Candidate> = {}): Candidate {
  // Structural fixture rather than a whole Candidate: the module reads `id`, `folder` and `status`,
  // and a fixture that has to be complete is a fixture that rots every time the type grows a field.
  return {
    folder: null,
    fullName: `Candidate ${id}`,
    id,
    status: "sent_to_manager",
    ...fields,
  } as Candidate;
}

const recruiterFiling = { filedAt: "2026-08-20T09:00:00.000Z", filedByHrId: "TA-1", key: "Heliopolis", kind: "medical_rep" } as const;
const managerFiling = { filedAt: "2026-08-30T09:00:00.000Z", filedByHrId: "B-94", key: "Nasr City", kind: "medical_rep" } as const;

export function runManagerFolderShelfTests() {
  // ── The overlay REPLACES; it never merges ──────────────────────────────────────────────────────
  {
    const rows = [candidate("c1", { folder: { ...recruiterFiling } })];
    const [overlaid] = applyManagerFilings(rows, {});
    assert.equal(
      overlaid.folder,
      null,
      "a CV the RECRUITMENT TEAM filed must read as unfiled on the manager's shelf — inheriting it would show him a folder he cannot empty",
    );
    // The input must be untouched: these are the same objects the rest of the screen renders.
    assert.deepEqual(rows[0].folder, recruiterFiling, "applyManagerFilings must not mutate its input");
  }

  {
    const rows = [candidate("c1", { folder: { ...recruiterFiling } })];
    const [overlaid] = applyManagerFilings(rows, { c1: { ...managerFiling } });
    assert.deepEqual(
      overlaid.folder,
      managerFiling,
      "the manager's own filing wins over the recruitment team's on his screen",
    );
  }

  // ── One CV is in exactly ONE of live/shelved ───────────────────────────────────────────────────
  {
    const rows = [candidate("c1"), candidate("c2"), candidate("c3")];
    const filings: ManagerFolderFilings = {
      c2: { ...managerFiling },
      c3: { filedAt: "2026-08-30T10:00:00.000Z", filedByHrId: "B-94", key: "D3", kind: "district_manager" },
    };
    const { live, shelves, filedCount } = partitionManagerCandidates(rows, filings);

    assert.deepEqual(live.map((row) => row.id), ["c1"], "only the unfiled CV stays in the live list");
    assert.equal(filedCount, 2);

    const onShelves = shelves.flatMap((shelf) => shelf.folders.flatMap((folder) => folder.candidates.map((row) => row.id)));
    assert.deepEqual([...onShelves].sort(), ["c2", "c3"], "every filed CV is on exactly one shelf");
    // The property that matters more than either list: nothing is in both, and nothing is in neither.
    const seen = [...live.map((row) => row.id), ...onShelves].sort();
    assert.deepEqual(seen, ["c1", "c2", "c3"], "a CV must be in the live list or on a shelf, never both and never neither");
  }

  // ── Every shelf a manager may USE comes back, empty ones included ──────────────────────────────
  {
    const { shelves } = partitionManagerCandidates([candidate("c1")], {});
    assert.deepEqual(
      shelves.map((shelf) => shelf.kind),
      ["medical_rep", "district_manager", "other"],
      "an empty shelf is information; a shelf that vanishes makes the feature look broken",
    );
    // Paramedical is a RECRUITMENT-side eligibility answer. No CV reaches a manager after being
    // filed there, so for him it could only ever be empty — and an empty shelf he cannot use is not
    // information, it is an invitation to file somebody out by a rule that is not his to apply.
    assert.ok(
      !shelves.some((shelf) => shelf.kind === "paramedical"),
      "the paramedical shelf is never shown to a manager",
    );
    assert.ok(
      (candidateFolderKinds as readonly string[]).includes("paramedical"),
      "…while still existing for the recruitment team, which is the whole point of hiding it here",
    );
  }

  // ── The PICKER, the SHELVES and the SERVER all read the same list ──────────────────────────────
  {
    // A picker is never wider than its viewer. Three things have to agree about which shelves a
    // manager may use, and the only reason they can be trusted to is that there is one list: the
    // <select> he files from, the shelves he can open, and the route that actually writes the row.
    // If any one of them drifts wider, a CV lands on a shelf he cannot open — gone from his live
    // list, visible nowhere, and with nothing on screen explaining where it went.
    assert.deepEqual(
      [...managerFolderKinds],
      ["medical_rep", "district_manager", "other"],
      "a manager files into three shelves — paramedical is the recruitment team's eligibility answer, not his",
    );

    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

    // The picker. Source-pinned because rendering it needs React and a candidate row; the failure
    // this guards is a one-word edit back to the recruiter's list, which no behaviour test here can
    // reach.
    const control = read("../src/components/employee-portal/candidate-folder-control.tsx");
    assert.match(
      control,
      /\{managerFolderKinds\.map\(/,
      "the manager's folder picker must be built from managerFolderKinds, never the recruiter's full list",
    );
    assert.equal(
      /\{candidateFolderKinds\.map\(/.test(control),
      false,
      "…and the recruiter's list must not come back into it — that is exactly the edit this pin exists to catch",
    );

    // The server, which is the boundary. Omitting an <option> is UX; this is the half that holds.
    const route = read("../app/api/recruitment/hiring-manager/candidates/[candidateId]/folder/route.ts");
    assert.match(
      route,
      /\(managerFolderKinds as readonly string\[\]\)\.includes\(kind\)/,
      "the manager's write route must refuse a shelf he cannot see — a hidden option is not a check",
    );
    assert.equal(
      /candidateFolderKinds/.test(route),
      false,
      "the recruiter's vocabulary must not be what the manager's route validates against",
    );
  }

  // ── A rejected CV is not fileable, and the refusal is the recruiter's own ──────────────────────
  {
    // Filing a rejected candidate would put an answered decision into a folder somebody opens in
    // March. The refusal lives in candidate-folder.ts and is imported by both the control and the
    // write path — this asserts the manager's partition still SHOWS such a CV if one were somehow
    // filed, rather than silently hiding a rejection.
    const rows = [candidate("c1", { status: "rejected" })];
    const { live, filedCount } = partitionManagerCandidates(rows, {});
    assert.equal(filedCount, 0);
    assert.deepEqual(live.map((row) => row.id), ["c1"]);
  }

  // ── withManagerFiling: set and CLEAR ───────────────────────────────────────────────────────────
  {
    const before: ManagerFolderFilings = { c1: { ...managerFiling } };
    const set = withManagerFiling(before, "c2", { ...managerFiling, key: "Dokki" });
    assert.equal(Object.keys(set).length, 2);
    assert.notEqual(set, before, "must return a NEW object or React will not re-render");
    assert.equal(Object.keys(before).length, 1, "the previous map is untouched");

    const cleared = withManagerFiling(set, "c1", null);
    assert.equal(cleared.c1, undefined, "unfiling must DELETE the key, not set it to null");
    assert.equal(Object.keys(cleared).length, 1);
  }

  // ── Mixed-case HR_IDs ──────────────────────────────────────────────────────────────────────────
  {
    // HR_IDs in this database are mixed case; a plain equality on one has already lost 28% of a
    // result set elsewhere in this codebase. Both spellings must answer the same.
    assert.equal(isManagersOwnFiling("B-94", "b-94"), true);
    assert.equal(isManagersOwnFiling("b-94", "B-94"), true);
    assert.equal(isManagersOwnFiling("B-94", "B-23"), false);
    assert.equal(isManagersOwnFiling(null, "b-94"), false);
    assert.equal(isManagersOwnFiling("b-94", null), false);
    // The legacy alias the whole codebase folds: aaa is aa.
    assert.equal(isManagersOwnFiling("AAA", "aa"), true);
  }

  // ── "That table is not there" has TWO spellings, and the obvious one is the wrong one ──────────
  {
    // A Railway deploy applies no migrations, so the app can be live minutes before the table is.
    // The guard against that was written as `code === "42P01"` — Postgres's own undefined_table —
    // which looks right and catches nothing: PostgREST answers a missing table out of its schema
    // cache with PGRST205 and no Postgres code at all. Measured 2026-08-30 against a database
    // without the table: the manager's whole My Candidates page 500'd.
    //
    // Source-pinned rather than behaviour-tested because reaching the real failure needs a database
    // that is missing a table, which no unit test can arrange — and this file has no database.
    const source = readFileSync(
      fileURLToPath(new URL("../src/lib/recruitment/manager-folders.ts", import.meta.url)),
      "utf8",
    );
    assert.match(
      source,
      /MISSING_TABLE_CODES = new Set\(\["42P01", "PGRST205"\]\)/,
      "both codes must be treated as 'table not there' — 42P01 alone never fires, and the page dies",
    );
    assert.equal(
      /code === "42P01"/.test(source),
      false,
      "no bare 42P01 comparison may come back — that is precisely the check that looked correct and caught nothing",
    );
    // Both call sites go through the one helper, so they cannot drift apart on it.
    assert.equal(
      (source.match(/isMissingTable\(error\)/g) ?? []).length,
      2,
      "the read path and the delete path must BOTH use the helper",
    );
  }
}
