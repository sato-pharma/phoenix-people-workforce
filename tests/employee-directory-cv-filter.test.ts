import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The CV filter on the employee directory — and the four lists it has to be in at once.
 *
 * WHAT ACTUALLY BREAKS HERE IS NOT THE FILTER, IT IS THE WIRING. Every filter on this screen is
 * repeated in five places: the state, the predicate, the `useMemo` dependency array, the
 * `hasActiveFilters` test and the `activeFilterCount` tally — plus `clearFilters`. Miss one and
 * nothing fails: miss the dependency array and the list silently does not re-filter when the
 * filter changes; miss `hasActiveFilters` and the empty-state tells somebody there are no
 * employees rather than none matching; miss `clearFilters` and Clear leaves it set. All three are
 * wrong in the same direction — the person believes a list that is not the list they asked for —
 * and none of them produces an error anywhere.
 *
 * THE ROW HALF IS THE SAME SHAPE. `EmployeeDirectoryRow` is built in FOUR places in
 * employee-directory.ts (two services, two shapes of joined data). A row built without `hasCv`
 * reads as "no CV on file" for everybody it describes, so the filter's whole answer would be
 * "nobody has one" on whichever screen went through the builder that was missed.
 *
 * 🔴 A CONSTRUCTOR IN ANOTHER FILE IS CAUGHT BY THE TYPE, NOT BY THIS TEST, AND THAT IS WORTH
 * SAYING BECAUSE IT ALREADY HAPPENED. `hasCv` is a required field, so a literal missing it is a
 * typecheck error naming the exact file and line — which is how the fallback row in
 * employee-portal/service.ts was found, on CI, after a repo-wide grep for the constructors had
 * missed it (it is typed by its return annotation, not by an inline `: EmployeeDirectoryRow`).
 * So do NOT try to make this file a repo-wide census of constructors: the compiler already is
 * one, it is exact, and a grep-based imitation would be both weaker and noisier. What is asserted
 * here is only what the type CANNOT see — the wiring, and that each in-file builder reads the
 * index rather than hard-coding a value.
 */

const DIRECTORY_PATH = "src/lib/employees/employee-directory.ts";
const MANAGEMENT_PATH = "src/components/employees/employee-management.tsx";
const CV_PATH = "src/lib/employees/employee-cv.ts";

function read(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

/** Every line of a bracketed list that starts at `anchor`, so a missing entry is visible. */
function listAfter(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  assert.notEqual(start, -1, `could not find \`${anchor}\` — this test's anchors have drifted`);
  const end = source.indexOf("]", start);
  assert.notEqual(end, -1, `\`${anchor}\` is no longer a bracketed list`);
  return source.slice(start, end);
}

export function runEmployeeDirectoryCvFilterTests() {
  const directory = read(DIRECTORY_PATH);
  const management = read(MANAGEMENT_PATH);
  const cv = read(CV_PATH);

  // ── 1. EVERY ROW BUILDER SETS hasCv ───────────────────────────────────────────────────────
  // Counted against hasPhoto rather than a number written here: the two are filled from the same
  // kind of cached index at the same four sites, so if a fifth builder is ever added, this fails
  // the day it is added rather than the day somebody notices a wrong tick.
  const photoBuilders = directory.match(/hasPhoto: photoMap\.has\(/g)?.length ?? 0;
  const cvBuilders = directory.match(/hasCv: cvHrIds\.has\(/g)?.length ?? 0;
  assert.ok(photoBuilders >= 4, `expected at least 4 directory row builders, found ${photoBuilders}`);
  assert.equal(
    cvBuilders,
    photoBuilders,
    `every directory row builder must set hasCv: found ${cvBuilders} against ${photoBuilders} that ` +
      "set hasPhoto. A builder without it reports everyone it describes as having no CV",
  );

  // Both places that load the index must actually load it, or `cvHrIds` is not in scope and the
  // builder above could not have compiled — asserted anyway, because a future edit could swap one
  // for a local empty set and stay green everywhere else.
  assert.ok(
    (directory.match(/getEmployeeCvHrIdSet\(\)/g)?.length ?? 0) >= 2,
    "both directory services must load the CV index, not just the one",
  );

  // And no builder may hard-code the answer. `hasCv: false` inside the directory service would
  // typecheck, pass every other assertion here, and report the whole company as having no CV.
  assert.ok(
    !/hasCv:\s*(true|false)/.test(directory),
    "a directory row's hasCv must come from the index, never a literal — a hard-coded false " +
      "typechecks and reports the whole company as missing a CV",
  );

  // ── 2. THE INDEX IS INVALIDATED WHERE CVs ARE WRITTEN ─────────────────────────────────────
  // writeCvColumns is the single write point for every CV change. Without this call the directory
  // can show a stale tick for up to the cache TTL — on the one screen whose job is to say who is
  // still missing a CV, which is exactly where a stale answer wastes somebody's afternoon.
  const writeColumns = cv.slice(
    cv.indexOf("async function writeCvColumns"),
    cv.indexOf("export async function setEmployeeCv"),
  );
  assert.ok(
    writeColumns.length > 200,
    "could not isolate writeCvColumns — the assertion below would be vacuous",
  );
  assert.ok(
    writeColumns.includes("invalidateEmployeeCvIndex()"),
    "writeCvColumns must drop the cached CV index: it is the one place every attach, replace, " +
      "carry-across and removal passes through",
  );

  // ── 3. THE FILTER IS IN ALL FIVE LISTS ────────────────────────────────────────────────────
  assert.ok(
    management.includes("const [cvFilter, setCvFilter]"),
    "the directory must hold the CV filter in state",
  );

  // The predicate. Compared as a boolean, not matched to a "yes"/"no" string like the bank-account
  // column beside it — hasCv is a real boolean, and `employee.hasCv === cvFilter` would be false
  // for everybody, which reads as "nobody matches" rather than as a bug.
  assert.ok(
    management.includes('employee.hasCv === (cvFilter === "yes")'),
    "the predicate must compare hasCv as a boolean against the chosen value",
  );

  for (const [label, anchor] of [
    ["the useMemo dependency array (the list would not re-filter)", "  }, [\n    areaFilter,"],
    ["hasActiveFilters (the empty state would claim there are no employees)", "const hasActiveFilters = Boolean("],
    ["activeFilterCount (the count on the Filters button)", "const activeFilterCount = ["],
    ["clearFilters (Clear would leave it set)", "function clearFilters() {"],
  ] as const) {
    const list = listAfter(management, anchor);
    assert.ok(
      /\bcvFilter\b|setCvFilter\(/.test(list),
      `the CV filter is missing from ${label}`,
    );
  }

  // ── 4. ONE WORDING ────────────────────────────────────────────────────────────────────────
  // The control, the CV panel on the record and the organogram seat popup all speak about the
  // same fact; the owner chose "No CV on file" for the popup on 2026-09-29.
  assert.ok(
    management.includes('label="CV on File"'),
    'the control must be labelled "CV on File", matching the wording on the record and the seat popup',
  );
}
