import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { candidateScreeningFacts, candidateScreeningRoleFamily, screeningRoleFamilies } from "../src/lib/recruitment/candidate-screening-facts.ts";
import { matchesScreeningNarrowing, type ScreeningFilterCandidateRow } from "../src/lib/recruitment/screening-filter.ts";
import { parseScreeningFilters } from "../src/lib/recruitment/screening-link.ts";

/**
 * "the system sees in his cv medical rep he send it as a medical rep but neglect that he is
 * applying as dsm."
 *
 * The owner, 2026-09-18, screening. Measured on production the same day with the module's own role
 * matcher: of the 649 candidates who stated a job they were applying for, 303 were missing from a
 * filter their own record answered — 244 of them never screened — because every Role filter in the
 * module asked for ONE family and got the CANDIDATE's. 55 of the 303 had asked for a district
 * manager seat, most of them senior medical reps: the promotion pipeline for a seat being actively
 * recruited, invisible on the one filter built to find it. The largest single group was 93 filed
 * under "Other" who had plainly asked to be Office Coordinators.
 *
 * `screening-filter.ts`'s own header states the rule this broke: filtering on a different fact from
 * the one displayed is not a narrower filter, it is a wrong one. The row displays BOTH facts — the
 * seat above, the current job below — so the filter has to match on both.
 *
 * WHAT MUST NOT CHANGE, and is pinned here too: `candidateScreeningRoleFamily` still answers with
 * ONE family, still the candidate's own title first. It is what the role CELL prints and what files
 * a CV, a cell has room for one answer, and flipping its order would re-break Mahmoud Refaat Selim
 * (2026-08-24) in the other direction.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

/** Abanoub Magdy's shape, production row cb3452cc — the row the owner was looking at. */
function promotionCandidate(overrides: Partial<ScreeningFilterCandidateRow> = {}): ScreeningFilterCandidateRow {
  return {
    appliedForJobTitle: "District Manager",
    currentJobTitle: "Senior Medical Representative",
    fullName: "Abanoub Magdy",
    id: "cb3452cc-a284-4f50-a03e-997b4198816f",
    status: "new",
    ...overrides,
  } as ScreeningFilterCandidateRow;
}

const anyViewer = { asOf: Date.parse("2026-09-18T00:00:00Z"), seenByAnyone: false, seenByViewer: false };

function inFilter(candidate: ScreeningFilterCandidateRow, role: string): boolean {
  return matchesScreeningNarrowing(candidate, parseScreeningFilters({ role }), anyViewer);
}

export function runScreeningRoleMismatchTests(): void {
  // ── 1 · THE HEADLINE INVARIANT ────────────────────────────────────────────
  // A senior medical rep who applied for a district manager seat is findable under the seat he
  // asked for. This is the assertion that fires when the filter goes back to one family.
  assert.equal(
    inFilter(promotionCandidate(), "district_manager"),
    true,
    "a senior medical rep who applied for District Manager must appear in the District Manager filter",
  );

  // And he has not been moved: he is still a medical rep, and still findable as one.
  assert.equal(
    inFilter(promotionCandidate(), "medical_rep"),
    true,
    "he is still a medical rep too — the fix adds a family, it does not swap one for the other",
  );

  // He belongs to neither of the families nobody claimed for him.
  // `area_regional_manager` is the real key — an unrecognised one makes parseRole return null,
  // which disables the filter entirely, so this assertion is only meaningful spelled correctly.
  assert.equal(inFilter(promotionCandidate(), "area_regional_manager"), false, "and to no other family");

  // ── 2 · THE FAMILIES, DIRECTLY ────────────────────────────────────────────
  const facts = candidateScreeningFacts(promotionCandidate());
  assert.deepEqual(
    [...screeningRoleFamilies(facts, "District Manager")].sort(),
    ["district_manager", "medical_rep"],
    "both the job he holds and the job he asked for",
  );

  // Deduplicated: the ordinary CV, where the two agree, is one family and not the same one twice.
  const plainRep = candidateScreeningFacts(promotionCandidate({ appliedForJobTitle: "Medical Representative" }));
  assert.deepEqual(
    screeningRoleFamilies(plainRep, "Medical Representative"),
    ["medical_rep"],
    "a candidate applying for the job he already holds is one family, not two",
  );

  // ── 3 · THE DISPLAY ANSWER IS UNTOUCHED ───────────────────────────────────
  // The cell still prints one family, and still the candidate's own — see the docstring above.
  assert.equal(
    candidateScreeningRoleFamily(facts, "District Manager"),
    "medical_rep",
    "the role CELL still answers with the candidate's own family, exactly as before",
  );

  // ── 4 · THE `unknown` BUCKET ──────────────────────────────────────────────
  // "Nobody ever told us" still means nobody told us, on either fact.
  const nameless = promotionCandidate({ appliedForJobTitle: null, currentJobTitle: null, fullName: "No Job Anywhere" });
  assert.deepEqual(screeningRoleFamilies(candidateScreeningFacts(nameless), null), [], "no job named anywhere");
  assert.equal(inFilter(nameless, "unknown"), true, "and that candidate is in the unknown bucket");

  // The shape the single answer could never reach. A current title naming no job we recruit for
  // answers "other" — NOT null, and not the applied-for text: `??` does not fire on a title that
  // is present and merely unrecognised. So before this fix a warehouse keeper who applied for a
  // district manager seat was in the "Other" filter alone, with District Manager on his own row.
  const unrecognised = promotionCandidate({ currentJobTitle: "Warehouse Keeper" });
  assert.equal(
    candidateScreeningRoleFamily(candidateScreeningFacts(unrecognised), "District Manager"),
    "other",
    "the single display answer reads Other here, which is why it could never file him under the seat",
  );
  assert.deepEqual(
    [...screeningRoleFamilies(candidateScreeningFacts(unrecognised), "District Manager")].sort(),
    ["district_manager", "other"],
    "both — the title we hold, and the seat he asked for",
  );
  assert.equal(
    inFilter(unrecognised, "district_manager"),
    true,
    "so the District Manager filter finds him, which it did not before",
  );
  assert.equal(inFilter(unrecognised, "other"), true, "and the Other filter still does");
  assert.equal(inFilter(unrecognised, "unknown"), false, "he is not somebody nobody named a job for");

  // ── 5 · THE REVIEW HEADER SAYS THE MISMATCH OUT LOUD ──────────────────────
  // The pane where the minute is spent showed the seat alone, so a promotion read as an ordinary
  // application for the job on the CV. Source-pinned: this suite cannot render the component, and
  // the fact worth pinning is that the line exists and is suppressed when the two say the same job.
  const header = read("src/components/recruitment/workstation/workstation-review-header.tsx");
  assert.match(header, /currentRoleLine/, "the review header derives a current-job line");
  assert.match(
    header,
    /normalizeJobTitle\(row\.currentRole\.value\) !== normalizeJobTitle\(row\.appliedForText\)/,
    "and prints it only when the current job is different words from the seat",
  );
  assert.match(header, /Currently \{currentRoleLine\}/, "worded as the list row words it");

  // The filter and the header must keep reading the same module, or they drift apart again.
  const filter = read("src/lib/recruitment/screening-filter.ts");
  assert.match(filter, /screeningRoleFamilies\(facts, candidateRowAppliedFor\(candidate\)\.text\)/, "the filter reads both families");
  assert.doesNotMatch(
    filter,
    /candidateScreeningRoleFamily/,
    "and no longer narrows on the single display answer",
  );

  console.log("  recruitment screening role mismatch: 15 assertions");
}
