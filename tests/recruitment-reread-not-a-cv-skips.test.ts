// Recruitment / ATS — the re-read script's "this file is not a CV" skip list.
//
// The incident, production 2026-08-21. The script's truth set is "candidate has no extraction row",
// which stands in for "was never read". That proxy INVERTS for a file that is not a CV: reading one
// does not fail, it succeeds on the wrong document. Two signed job offers were read as
//
//     Fady Nashaat   fullName        = "Total Monthly Package"                   (a salary header)
//     Hesham Abdelaziz  currentJobTitle = "Medical Sales Representative Job Offer"  (HIGH confidence)
//
// A job offer has a clean text layer, so the free rules engine parses it confidently into the wrong
// fields — this is not a vision-model problem and no "did the model answer?" check catches it. Both
// rows were deleted, which returned both candidates to the target set, which is why a hard skip
// list exists at all.
//
// What this pins is narrow but load-bearing: the list must be REAL ids that carry their evidence,
// and the run must REPORT what it skipped. A skip that quietly matches nothing is worse than no
// skip, because it reads as coverage.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

export function runRecruitmentRereadNotACvSkipsTests() {
  // The script calls main() at module scope — importing it would run it against production — so
  // this reads the source rather than the values.
  const source = read("scripts/recruitment-reread-never-read-cvs.ts");

  const listStart = source.indexOf("const NOT_A_CV_CANDIDATES");
  assert.ok(listStart > 0, "NOT_A_CV_CANDIDATES must exist — it is the only thing keeping confirmed non-CVs out of the spend");
  // Slice from the array literal, not the declaration: the inline ReadonlyArray<{...}> annotation
  // is itself a brace pair and would otherwise be counted as a fourth entry.
  const arrayStart = source.indexOf("= [", listStart);
  assert.ok(arrayStart > listStart, "NOT_A_CV_CANDIDATES must be an array literal");
  const list = source.slice(arrayStart, source.indexOf("];", arrayStart));

  // Real uuids, not placeholders.
  const ids = [...list.matchAll(/id:\s*"([0-9a-f-]{36})"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 3, `expected at least the 3 confirmed job offers, found ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, "a duplicated id silently overstates how many candidates the list covers");

  // Every entry carries its evidence. An id with no reason behind it can never be safely removed,
  // and removing one wrongly re-arms exactly the spend this list exists to prevent.
  const entries = [...list.matchAll(/\{[^}]*\}/g)].map((m) => m[0]);
  assert.equal(entries.length, ids.length, "every entry must be a single object literal");
  for (const entry of entries) {
    for (const key of ["id", "name", "file", "why"]) {
      // Plain substring, deliberately not a built RegExp: `\b` inside a template literal is the
      // BACKSPACE character, not a word boundary, and that silently made this assertion unmatchable.
      assert.ok(entry.includes(`${key}:`), `every skip entry needs \`${key}\` — an id alone is unremovable later: ${entry}`);
    }
    const why = /why:\s*"([^"]*)"/.exec(entry)?.[1] ?? "";
    assert.ok(why.length > 30, `the reason must say what the file IS and how it read, not just "not a cv": ${JSON.stringify(why)}`);
  }

  // The run has to say what it skipped, and flag a listed id that matched nothing.
  assert.match(
    source,
    /skipped \$\{skipped\} of \$\{NOT_A_CV_CANDIDATES\.length\} listed/,
    "the summary must print hits AND list size — a skip entry that matches nothing reads as coverage while doing nothing",
  );
  assert.match(
    source,
    /was not in the target set this run/,
    "a listed id that matched nothing must be named, or a stale entry rots unnoticed",
  );

  // The filter must actually be applied to the target set, not merely computed.
  assert.match(
    source,
    /targets = targets\.filter\(\(row\) => !notACvIds\.has\(String\(row\.id\)\)\)/,
    "the list must be subtracted from targets — a computed-but-unused set is the classic silent no-op",
  );

  // is_cv is the real fix; this list is the pre-3f3c0e05 backfill for rows whose judgement is gone.
  // Keep that pointer alive so the list does not quietly become the primary mechanism.
  assert.match(
    source,
    /is_cv/,
    "the list must point at is_cv as the durable mechanism, or it becomes a hand-kept registry nobody dares prune",
  );
}
