import assert from "node:assert/strict";

import { partitionCandidatesByFolder } from "../src/lib/recruitment/candidate-folder.ts";
import {
  candidateMatchesPoolQuery,
  normalizeCandidatePoolQuery,
} from "../src/lib/recruitment/candidate-pool-search.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

// Recruitment — a CV filed to a folder must stay OFF the pool and stay FINDABLE.
//
// The owner reported on 2026-09-03 that CVs he had received were "not appearing anywhere". They had
// not been lost: 734 candidates existed and every one of that day's 92 linked correctly. 150 of them
// were filed into folders, which removes them from the pool BEFORE search and before every filter,
// and the Folders tab has no search box of its own — so no screen in the application could find a
// filed person by name. A CV nobody can look up is indistinguishable from one that was lost.
//
// The fix must hold BOTH halves at once, and the second is the one at risk of being "fixed" back:
//   1. filing still removes the CV from the pool  (owner's rule, in his own words:
//      "the CV that I push to a folder ... it is not appearing now on the main page")
//   2. the same search predicate still finds that person on the filed half
//
// A test that only asserts (2) would pass a change that put filed CVs back on the main page, which
// is the exact thing the owner asked for and would have to be undone again.

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    appliedForJobTitle: null,
    createdAt: "2026-09-03T10:00:00.000Z",
    email: null,
    folder: null,
    fullName: "Unnamed",
    id: "c-0",
    nationalId: null,
    phone: null,
    source: "whatsapp",
    status: "new",
    ...overrides,
  } as Candidate;
}

export function runCandidatePoolFiledSearchTests() {
  const filed = candidate({
    fullName: "Samaa Shalaby",
    id: "filed-1",
    folder: {
      filedAt: "2026-09-03T11:00:00.000Z",
      filedByHrId: "B-10",
      key: "Office Coordinator",
      kind: "other",
    },
    phone: "+201098500699",
  });
  const inPool = candidate({ fullName: "Mohamed Abdelfattah", id: "pool-1" });
  const all = [filed, inPool];

  // ── 1. Filing still takes the CV off the pool. The owner's rule, unchanged. ──────
  const { pool, shelves, filedCount } = partitionCandidatesByFolder(all);
  assert.equal(filedCount, 1, "the filed CV must be counted as filed");
  assert.deepEqual(
    pool.map((c) => c.id),
    ["pool-1"],
    "a filed CV must NOT be in the pool half — putting it back is the thing the owner asked to stop",
  );

  // ── 2. The same predicate finds that person on the filed half. ──────────────────
  const q = normalizeCandidatePoolQuery("  Samaa  ");
  assert.equal(q, "samaa", "the query is trimmed and lowercased before it is used");

  const filedMatches = shelves.flatMap((shelf) =>
    shelf.folders.flatMap((folder) => folder.candidates.filter((c) => candidateMatchesPoolQuery(c, q))),
  );
  assert.deepEqual(
    filedMatches.map((c) => c.id),
    ["filed-1"],
    "searching a filed applicant's own name must find them — before this fix, no screen could",
  );

  // Searching the pool half alone is what the bug looked like: zero results for a person who exists.
  assert.equal(
    pool.filter((c) => candidateMatchesPoolQuery(c, q)).length,
    0,
    "the pool half alone cannot answer for a filed person — which is why the filed half is searched too",
  );

  // ── 3. An empty box is not a search. ────────────────────────────────────────────
  assert.equal(normalizeCandidatePoolQuery("   "), "", "an all-whitespace box must read as no search");
  assert.equal(
    candidateMatchesPoolQuery(filed, ""),
    true,
    "an empty query matches everything, so callers gate the filed band on the query being non-empty",
  );

  // ── 4. The predicate reads the fields the box advertises. ───────────────────────
  assert.equal(candidateMatchesPoolQuery(filed, "201098500699"), true, "phone is searchable");
  assert.equal(candidateMatchesPoolQuery(filed, "whatsapp"), true, "source is searchable");
  assert.equal(candidateMatchesPoolQuery(filed, "zzz-nobody"), false, "a non-match must still be a non-match");
}
