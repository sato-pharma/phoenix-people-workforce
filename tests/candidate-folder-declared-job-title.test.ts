import assert from "node:assert/strict";

import { resolveCandidateRegionFolderCode } from "../src/lib/recruitment/candidate-folder.ts";
import { suggestFolderFromDeclaredAnswers } from "../src/lib/recruitment/candidate-folder-suggestion.ts";
import { candidateRegionCodes } from "../src/lib/recruitment/candidate-region.ts";
import { namesAnOccupation } from "../src/lib/recruitment/candidate-role-family.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

/**
 * THE TWO SHELVES THAT COULD STILL BE NAMED BY SOMETHING NOBODY READ.
 *
 * PR #3719 closed the AREA hole: a medical rep's typed area must match `au.canonical_areas` or the
 * CV is refused rather than opening a stray folder. Two holes of the same shape were left open, and
 * this file pins both.
 *
 * ONE — THE JOB TITLE. Measured against production 2026-09-11, a candidate whose
 * `applied_for_job_title` read "بخصوص الإعلان دا" ("regarding this ad") had a folder of exactly that
 * name opened for her by the bulk "file the declared CVs" action, one shelf away from the Medical
 * Representative folder she belonged on. The WhatsApp flow writes whatever the applicant last typed
 * into that column, and the "other" shelf is keyed on it VERBATIM, so nothing anywhere asked whether
 * the text was a job.
 *
 * The gate is deliberately NOT "which family is this". The owner's split is *"8 regions, and split
 * other positions by job title"*, and "Regulatory Affairs Specialist" — the example the sibling
 * suite already pins — belongs to no family here. Refusing it would break the feature in the name of
 * fixing it. So the question asked is the weaker one, *is this a job at all*, and the answer is
 * measured below against every distinct job title in production.
 *
 * TWO — THE REGION CODE. `fileCandidateToFolder` stored whatever key arrived for the district
 * manager shelf. Production is clean there today (5 folders, all real codes, verified 2026-09-12);
 * `resolveCandidateRegionFolderCode` is what keeps it clean rather than what repairs it.
 *
 * Both resolvers are pinned DIRECTLY rather than through `fileCandidateToFolder`, which reaches a
 * live database — and this suite runs with production credentials (AGENTS.md §2.1).
 */

/** A candidate carrying only the fields the suggestion reads. */
function declared(id: string, title: string | null): Candidate {
  return {
    id,
    fullName: id,
    faculty: null,
    backgroundConfirmedOutcome: null,
    backgroundConfirmedAt: null,
    status: "new",
    appliedForJobTitle: title,
    preferredAreaName: null,
    preferredRegionCode: null,
    preferredRegionName: null,
    preferencesDeclaredAt: "2026-09-11T06:00:00Z",
    folder: null,
  } as unknown as Candidate;
}

const CANONICAL_AREAS = ["Alex West", "Gharbia 1 (Tanta)"];

/**
 * EVERY DISTINCT JOB TITLE IN PRODUCTION, read 2026-09-12 — the negative control, and the reason
 * this list is long rather than illustrative. A gate that refuses text is only safe if it is
 * measured against the real text it will meet, and the first draft of `namesAnOccupation` refused
 * all ten of the free-typed ones because a heredoc had eaten a backslash out of its pattern. A
 * handful of invented examples would have passed that draft happily.
 */
const REAL_PRODUCTION_TITLES = [
  "Accountant",
  "Administrative Assistant",
  "Area / District Sales Manager",
  "Area / Regional Manager",
  "Area Sales Manager",
  "Cairo District Manager",
  "Chief Accountant",
  "District Manager",
  "District Manager (Cairo)",
  "District Manager for Upper Egypt",
  "District Manager position",
  "Entry-level position in Human Resources",
  "Entry-level Veterinary Medical Representative",
  "Finance & Accounting",
  "Financial Accountant",
  "HR Generalist / HR Operations / Personnel & Payroll",
  "HR Generalist role",
  "HR Operations Specialist, HR Generalist, or HRBP",
  "HR Specialist",
  "HR Supervisor",
  "Human Resources",
  "Junior Accountant",
  "Marketing manager",
  "Marketing Representative",
  "Medical Representative",
  "Medical Representative - Damietta and Port Said",
  "Medical Representative - Pedia Line",
  "Medical Representative - Tanta, Gharbia",
  "Medical Representative – Damietta & Port Said Area",
  "Medical Representative – Ismailia and Suez",
  "Medical Representative – Pedia Line",
  "Medical Representative (Pedia Line) — Sharkia regions",
  "Medical Representative (Port Said)",
  "Medical Representative (Zagazig or Diarb Negm)",
  "Medical Sales",
  "Medical Sales Representative (training opportunity)",
  "National Sales",
  "National Sales Manager",
  "Office Coordinator",
  "Office Coordinator (Sheraton, Cairo)",
  "Office manager vacancey",
  "Operations Coordinator / Operations Executive",
  "Personnel and Recruitment Specialist",
  "Product Manager",
  "Product Specialist",
  "Project - Account manager",
  "Purchase Officer / Store/Logistic Supervisor / HR & Admin Officer",
  "Regulatory Affairs Specialist",
  "Respiratory Therapist",
  "sales Administration",
  "Sales Director",
  "Sales Manager",
  "Sales Managerial Position",
  "Senior district manager Cairo",
  "Technical Support and infrastructure Engineer",
  "Upper Egypt 2 District Manager",
  "Upper Egypt District Sales Manager",
  "محامي",
];

/** The two production values that are NOT job titles — one a reply, one a description of duties. */
const NOT_A_JOB_TITLE = [
  "بخصوص الإعلان دا",
  "reservation (arrange & book hotels accommodation for employees)",
];

export function runCandidateFolderDeclaredJobTitleTests() {
  // ── 1 · NEGATIVE CONTROL — every real title in production still names a job ──
  // This runs first on purpose. Without it, part 2 passing means nothing: a gate that refuses
  // everything refuses the WhatsApp reply too, and reads exactly like a working one.
  for (const title of REAL_PRODUCTION_TITLES) {
    assert.equal(
      namesAnOccupation(title),
      true,
      `"${title}" is a real job title in production and must never be refused`,
    );
  }

  // ── 2 · The text that is not a job is refused ─────────────────────────────
  for (const text of NOT_A_JOB_TITLE) {
    assert.equal(namesAnOccupation(text), false, `"${text}" names no job and must not be able to open a folder`);
  }

  // Blank input is not a job either, and answers false rather than throwing.
  for (const empty of [null, undefined, "", "   "]) {
    assert.equal(namesAnOccupation(empty), false, `${JSON.stringify(empty)} names no job`);
  }

  // ── 3 · The suggestion refuses the reply, WITH A REASON ───────────────────
  // The refusal is the product here, not the null: a screen listing CVs it could not file with no
  // reason beside them is a screen nobody acts on — the same standard the sibling module holds.
  const reply = suggestFolderFromDeclaredAnswers(declared("yasmeen", "بخصوص الإعلان دا"), CANONICAL_AREAS);
  assert.equal(reply.suggestion, null, "a WhatsApp reply must not open a folder named after itself");
  assert.ok(
    String(reply.refusal).includes("names no job"),
    `the refusal must say why; got ${JSON.stringify(reply.refusal)}`,
  );
  assert.ok(
    String(reply.refusal).includes("بخصوص الإعلان دا"),
    "and must quote the text, so the recruiter can see what the applicant actually wrote",
  );

  const duties = suggestFolderFromDeclaredAnswers(
    declared("duties", "reservation (arrange & book hotels accommodation for employees)"),
    CANONICAL_AREAS,
  );
  assert.equal(duties.suggestion, null, "a description of duties is not a folder name either");

  // ── 4 · A REAL typed title still files, under its own words ───────────────
  // The owner's split, unchanged. Both of these belong to no role family at all, which is exactly
  // the case the "other" shelf exists for — a gate keyed on the family would refuse them.
  for (const title of ["Regulatory Affairs Specialist", "Technical Support and infrastructure Engineer"]) {
    const result = suggestFolderFromDeclaredAnswers(declared(title, title), CANONICAL_AREAS);
    assert.equal(result.suggestion?.kind, "other", `"${title}" must still reach the other shelf`);
    assert.equal(result.suggestion?.key, title, "and under the title itself, not a family label");
  }

  // ── 5 · A TAPPED label files even when it names no occupation word ────────
  // "Other" is one of this system's own eleven labels and carries no seat noun, so it fails
  // `namesAnOccupation` on its own. It must still file: an answer chosen off our own menu is not
  // free text, and two CVs sit in that folder in production today.
  assert.equal(namesAnOccupation("Other"), false, "the control for this case — the label alone names no job");
  const tappedOther = suggestFolderFromDeclaredAnswers(declared("tapped-other", "Other"), CANONICAL_AREAS);
  assert.equal(tappedOther.suggestion?.kind, "other");
  assert.equal(tappedOther.suggestion?.key, "Other", "a tapped label is never second-guessed");

  // ── 6 · The region folder key — every real code resolves, nothing else ────
  for (const code of candidateRegionCodes) {
    assert.equal(
      resolveCandidateRegionFolderCode(code).code,
      code,
      `${code} is a live region and must open its folder`,
    );
  }
  assert.equal(
    resolveCandidateRegionFolderCode("ue").code,
    "UE",
    "case folds to the canonical code, so one folder and not two",
  );
  assert.equal(resolveCandidateRegionFolderCode("  d3  ").code, "D3", "and so does stray whitespace");

  // A region NAME is not a region CODE. This is the shape that would arrive from a hand-made request
  // or a caller reading the label instead of the key, and it must be refused rather than opening a
  // folder `candidateFolderLabel` cannot name.
  for (const notACode of ["Delta (3)", "Upper Egypt", "Cairo", "D4", "ZZ", ""]) {
    const result = resolveCandidateRegionFolderCode(notACode);
    assert.equal(result.code, null, `"${notACode}" is not a region code and must be refused`);
    assert.ok(result.refusal, "the refusal is never blank — a screen must be able to show a reason");
  }
}
