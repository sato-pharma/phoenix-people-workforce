// CV Database — the candidate pool, read as a CV library.
//
// This screen used to hold nothing. `CvDatabaseManager` parsed an uploaded .xlsx into React state
// and rendered it; there was no loader, no route, no table behind it, and `app/api/cv-database/`
// contained only `template/`. Reloading the page emptied it. Measured 2026-08-24: 0 rows on screen
// while `ats_candidates` held 562 people, every one of them with a CV already read and extracted —
// so Phoenix had a candidate database and a page called "CV Database" that shared no data at all.
//
// Owner decision 2026-08-24: one dataset. This maps the pool the recruitment workspace already
// loads (listCandidates) onto the CV-facing view — what someone does now, for how long, where they
// studied, where they live — so the two screens can never disagree about who exists.
//
// Pure: no DB and no React, so the mapping is testable on its own and the page stays a thin loader.

import { formatDurationMonths, monthsBetween, type CvExperienceStatus } from "@/lib/cv/cv-database";
import {
  judgeBackground,
  type BackgroundOutcome,
  type BackgroundSource,
} from "@/lib/recruitment/candidate-background";
import { candidateScreeningFacts } from "@/lib/recruitment/candidate-screening-facts";
import { cairoDayKey } from "@/lib/recruitment/candidate-stats";
import type { Candidate } from "@/lib/recruitment/types";

export type CvLibraryRow = {
  id: string;
  name: string;
  /** The day the CV arrived, in Africa/Cairo — never a raw UTC timestamp. */
  receivedOn: string;
  currentJobTitle: string;
  /**
   * The job they asked us FOR, which is regularly not the one above — a senior medical rep applying
   * for a district manager seat is both. Carried so the Role filter can find them under either; a
   * filter that knew only `currentJobTitle` could not find a CV under the seat it was sent in for.
   */
  appliedForJobTitle: string;
  currentEmployer: string;
  totalExperience: string;
  medicalSales: CvExperienceStatus;
  medicalSalesDuration: string;
  medicalSalesEmployer: string;
  education: string;
  /**
   * The same education, split at its own field boundary so the widest column on the screen can be
   * two short lines instead of one very long one.
   *
   * "Bachelor of Pharmacy · Cairo University (2019)" is one string a reader scans left to right, and
   * it was single-handedly forcing the table 300px wider than its container. Splitting it is not
   * wrapping — these are separately-extracted fields being shown on their own lines, the same idiom
   * every other cell here already uses. `education` keeps the joined form, because the export
   * carries one column per fact and must not change shape when the screen relayouts.
   */
  educationDegree: string;
  educationFaculty: string;
  educationInstitution: string;
  /** Where their CV says they LIVE. */
  governorate: string;
  /**
   * Where they will WORK, which is a different question and the one this screen filters on.
   *
   * Resolved through `candidateScreeningFacts`, the same function the recruitment pool reads, so
   * the two screens cannot answer it differently. Before this, the pool honoured the applicant's
   * own WhatsApp answer and this screen re-derived a region from the governorate — so the same
   * person could sit in Giza on one screen and nowhere at all on the other.
   *
   * `regionCode` is null both when nothing is known AND when somebody typed a region we cannot
   * place; `regionLabel` still carries their words in the second case, which is why the two are
   * separate fields rather than one.
   */
  regionCode: string | null;
  regionLabel: string;
  /** True when the applicant chose the region themselves rather than it being read off the CV. */
  regionDeclared: boolean;
  /**
   * The country, when the address on the CV is outside Egypt. Empty for everyone else.
   *
   * A foreign address has no region code and never will, so without this it looks identical to a
   * candidate whose CV gave no address at all — and the two want completely different handling.
   */
  regionForeignCountry: string;
  /** The area they asked for, in their own words. Empty for anyone who was never asked. */
  preferredArea: string;
  cvFileName: string;
  /**
   * Answers to the Super-Admin-defined extra WhatsApp screening questions
   * (whatsapp-screening-questions.ts), labelled against the CURRENT question list — including
   * retired ones, so a later prompt-text fix benefits old answers too and a retired question's
   * historical answer still shows rather than vanishing. Empty for every candidate until an admin
   * adds a question and someone answers it. Ordered the same way the admin builder orders them.
   */
  screeningAnswers: { label: string; answer: string }[];
  /**
   * Whether their academic background admits them to the FIELD FORCE — the owner's standing rule
   * that a paramedical degree is refused for a rep or a district manager and is perfectly normal
   * for an office coordinator.
   *
   * NOT decided here. `judgeBackground` has answered this for every candidate since the background
   * review shipped; what it never had was a way to ask. Measured on production 2026-09-07: 328
   * eligible, 295 paramedical, 252 unknown — so a THIRD of every list a recruiter scrolls is people
   * who cannot take the job being screened for, with no way to set them aside. Reusing the engine
   * rather than re-reading `faculty` here is the whole point: a second opinion about somebody's
   * degree is how two screens start disagreeing about the same person.
   */
  backgroundOutcome: BackgroundOutcome;
  /**
   * How the verdict was reached — "declared" when the applicant gave their own background, "cv" when
   * the extractor read it off the document, null when neither.
   *
   * Beside the outcome because they are different strengths of one claim: 252 of the verdicts come
   * from the applicant's own answer and 371 from a machine reading a PDF. Showing only the outcome
   * invites a recruiter to treat those as equal.
   */
  backgroundSource: BackgroundSource | null;
  /**
   * The graduation year as a NUMBER, for the range filter — `education` already carries it inside a
   * display string and a filter cannot read it back out of one.
   *
   * Null for the 172 candidates with no year on file, and the filter must keep them reachable: a
   * range that silently hides a fifth of the pool is worse than no range at all.
   */
  graduationYear: number | null;
  /**
   * Total experience as a NUMBER of years. `totalExperience` above is the same fact formatted for
   * reading ("2 years 3 months") and cannot be compared.
   *
   * Null for 426 of 875 — nearly half — which makes this the field most likely to be misused. See
   * the filter's own note: a naive minimum silently drops every one of them.
   */
  yearsExperienceValue: number | null;
  /**
   * The degree grade reduced to one of the four Egyptian names, or null when the CV recorded
   * something that is not one of them — a GPA, a percentage, a letter.
   *
   * Null therefore has TWO causes, which is why `degreeGradeRaw` sits beside it: nothing on file at
   * all, and something on file we decline to convert. The filter has to tell those apart.
   */
  degreeGrade: DegreeGrade | null;
  /**
   * Exactly what the CV said, trimmed — `"GPA: 3.46/4.00 | Honors | Ranked 6th"` and all. Empty
   * string when the record carries no grade.
   *
   * Kept because it is the only thing that distinguishes "we have no grade" from "we have a grade
   * we do not name", and because a recruiter looking at the `other` bucket needs to see the actual
   * value to judge it. Never normalised for display: the CV's own words are the fact.
   */
  degreeGradeRaw: string;
};

/**
 * The graduation-year buckets the CV screen offers, and the experience bands beside them.
 *
 * BUCKETS RATHER THAN TWO NUMBER INPUTS, for one reason that is not taste: a native `<select>` is
 * the one control the fits-the-screen rule cannot shrink, and the filter bar already carries four.
 * A pair of number inputs per range would put eight controls on a 375px screen. A bucket also asks
 * the question a recruiter actually has — "fresh graduate or experienced" — instead of making them
 * invent a year.
 *
 * `"none"` IS THE LOAD-BEARING OPTION IN BOTH. 172 of 875 candidates have no graduation year and
 * 426 have no years-of-experience figure — nearly half. A range filter without an explicit way to
 * ask for them makes those people unreachable the moment anyone narrows, and unreachable reads
 * exactly like "we have nobody", which is the failure this whole screen exists to prevent. Empty
 * string means "any" and is the only value that returns everyone.
 */
export type GraduationBucket = "" | "recent" | "mid" | "older" | "none";

export type ExperienceBand = "" | "under2" | "2to5" | "5to10" | "over10" | "none";

/**
 * The order the options are OFFERED in, which is not the order a Record happens to iterate.
 *
 * Both run newest-first and put the "not on file" bucket last. Reading them out of the label object
 * would order them however the keys were typed — "2015–2021, not on file, before 2015, 2022 or
 * later" — which is not a sequence anybody scans.
 */
export const graduationBuckets: readonly Exclude<GraduationBucket, "">[] = ["recent", "mid", "older", "none"];

export const experienceBands: readonly Exclude<ExperienceBand, "">[] = ["under2", "2to5", "5to10", "over10", "none"];

/**
 * The four grades an Egyptian degree is actually awarded in, plus the two honest non-answers.
 *
 * WHY THIS NEEDED NORMALISING BEFORE IT COULD BE A FILTER. 318 candidates carry a grade and they do
 * so in 98 DISTINCT SPELLINGS. "Very Good" appears as `Very Good`, `Very good`, `very good`,
 * `very Good`, `VERY GOOD`, `V.Good`, `V.good`, `Very Good.`, `جيدجدا`, and eleven further forms
 * that bolt on an honours clause or a GPA — `Very Good with Honors (Ranked 3rd in the department)`,
 * `GPA: 3.45 (86.25%) Very Good`, `Cumulative Grade : very good with\nHonors.`. Offering the raw
 * column as a facet would have produced ninety-odd buttons, nineteen of which mean "very good".
 *
 * `other` IS NOT A DUMPING GROUND, it is a refusal to guess. Around fifty of the 318 carry only a
 * number or a letter — `3.67`, `GPA: 3.00 / 5.00`, `65%`, `B+ (3.462/4.0)`, `2nd div`, `CGPA: 8.60`.
 * Naming those needs the awarding scale (4.0? 5.0? percentage? the 10-point scale `8.09` and
 * `CGPA: 8.60` imply) and each university's own cut-offs. One invented mapping across all of them
 * would print a confident grade on a record that never carried one, which is worse than saying the
 * CV recorded something we do not read. They stay reachable under their own option.
 */
export type DegreeGrade = "excellent" | "very_good" | "good" | "pass";

export type GradeFilter = "" | DegreeGrade | "other" | "none";

export const degreeGradeLabels: Record<DegreeGrade, string> = {
  excellent: "Excellent",
  good: "Good",
  pass: "Pass",
  very_good: "Very Good",
};

/** Best grade first, then the two non-answers — the order an Egyptian reader expects. */
export const gradeFilterOptions: readonly Exclude<GradeFilter, "">[] = [
  "excellent",
  "very_good",
  "good",
  "pass",
  "other",
  "none",
];

export const gradeFilterLabels: Record<Exclude<GradeFilter, "">, string> = {
  ...degreeGradeLabels,
  none: "Grade not on file",
  other: "A GPA or letter grade",
};

/**
 * One free-typed grade reduced to the four names, or null when it names none of them.
 *
 * ORDER IS THE WHOLE ALGORITHM, and getting it wrong fails silently: "Very Good" CONTAINS "good",
 * so a `good` test running first swallows all 120 very-good candidates into `good` — and the counts
 * still add up to 318, so nothing looks broken. Very good is matched before good, and the Arabic
 * جيد جدا before جيد for the same reason: `جيدجدا`, which one candidate wrote without the space,
 * contains `جيد`.
 *
 * Honours clauses are deliberately NOT a separate outcome. `Excellent with Honours` is an Excellent
 * degree; splitting it would put one person's grade in two buckets and halve both counts.
 */
export function normalizeDegreeGrade(raw: string | null | undefined): DegreeGrade | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;

  // Arabic first — a record carrying only Arabic never reaches the Latin tests below.
  if (value.includes("امتياز")) return "excellent";
  if (value.includes("جيد جدا") || value.includes("جيدجدا")) return "very_good";
  if (value.includes("جيد")) return "good";
  if (value.includes("مقبول")) return "pass";

  // The STEM, not the word: `Excellence with grade of honor.` and `Excellent degree with honors`
  // are both an Excellent degree and neither spells the word the same way.
  if (value.includes("excellen")) return "excellent";
  // `v.good`, `v. good` and `v good` abbreviate the same grade — the dot and the space are each
  // optional, which is why this is a pattern rather than a list of literals.
  if (/very\s*good/.test(value) || /\bv\.?\s*good/.test(value)) return "very_good";
  if (value.includes("good")) return "good";
  if (value.includes("pass") || value.includes("accept")) return "pass";
  return null;
}

/**
 * `"other"` and `"none"` answer different questions and must never be merged: one means the CV
 * recorded something we do not turn into a grade, the other that it recorded nothing at all.
 * Folding them hides fifty people behind a label claiming their record is empty when it is not.
 */
export function matchesGradeFilter(
  row: Pick<CvLibraryRow, "degreeGrade" | "degreeGradeRaw">,
  filter: GradeFilter,
): boolean {
  if (!filter) return true;
  if (filter === "none") return row.degreeGradeRaw === "";
  if (filter === "other") return row.degreeGradeRaw !== "" && row.degreeGrade === null;
  return row.degreeGrade === filter;
}

/** The labels, kept beside the logic so a new bucket cannot ship without one. */
export const graduationBucketLabels: Record<Exclude<GraduationBucket, "">, string> = {
  mid: "Graduated 2015–2021",
  none: "Graduation year not on file",
  older: "Graduated before 2015",
  recent: "Graduated 2022 or later",
};

export const experienceBandLabels: Record<Exclude<ExperienceBand, "">, string> = {
  "2to5": "2–5 years",
  "5to10": "5–10 years",
  none: "Experience not on file",
  over10: "Over 10 years",
  under2: "Under 2 years",
};

/**
 * 2022 is the boundary because it is where this pool actually splits: 326 of the 703 candidates
 * with a year on file graduated in 2022 or later. A rounder number would have put a lopsided
 * majority on one side and told a recruiter nothing.
 */
export function matchesGraduationBucket(row: Pick<CvLibraryRow, "graduationYear">, bucket: GraduationBucket): boolean {
  if (!bucket) return true;
  const year = row.graduationYear;
  if (bucket === "none") return year === null;
  if (year === null) return false;
  if (bucket === "recent") return year >= 2022;
  if (bucket === "mid") return year >= 2015 && year <= 2021;
  return year < 2015;
}

/**
 * Bands are half-open upwards — "2–5 years" is 2 up to but not including 5 — so a candidate with
 * exactly five years appears in "5–10" and in exactly one band. Overlapping edges are how the same
 * person shows up twice and the counts stop adding up.
 */
export function matchesExperienceBand(row: Pick<CvLibraryRow, "yearsExperienceValue">, band: ExperienceBand): boolean {
  if (!band) return true;
  const years = row.yearsExperienceValue;
  if (band === "none") return years === null;
  if (years === null) return false;
  if (band === "under2") return years < 2;
  if (band === "2to5") return years >= 2 && years < 5;
  if (band === "5to10") return years >= 5 && years < 10;
  return years >= 10;
}

export type CvLibrarySummary = {
  averageExperienceMonths: number;
  candidates: number;
  employers: number;
  experienced: number;
  fresh: number;
  unknown: number;
};

/** Every cell renders a dash rather than an empty box, so a blank never reads as a layout fault. */
export const CV_LIBRARY_BLANK = "\u2014";

function text(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : "";
}

/**
 * "Bachelor of Pharmacy, Cairo University (2019)" out of four separately-extracted columns.
 *
 * Joined with a middle dot rather than a comma because any of the four can be absent and a run of
 * stray commas is how a half-filled record announces itself as broken.
 */
function educationLine(candidate: Candidate): string {
  const parts = [text(candidate.degree), text(candidate.faculty), text(candidate.university)].filter(Boolean);
  const line = parts.join(" \u00b7 ");
  const year = candidate.graduationYear;
  if (!line) return year ? String(year) : "";
  return year ? `${line} (${year})` : line;
}

/**
 * How long they sold pharmaceuticals for.
 *
 * The dates are the better source when both are present; `yearsExperience` is TOTAL experience
 * across any field and is not the same measurement, so it is never substituted in here.
 */
function medicalSalesMonths(candidate: Candidate): number | null {
  const from = text(candidate.medicalRepExperienceFrom);
  if (!from) return null;
  return monthsBetween(from, text(candidate.medicalRepExperienceTo));
}

/**
 * Has this person sold pharmaceuticals before?
 *
 * Read straight off the stored boolean rather than re-derived from free text the way the workbook
 * importer had to. NULL stays its own answer: "the CV did not say" is not "no", and folding the two
 * together is what would quietly hide a third of the pool.
 */
function medicalSalesStatus(candidate: Candidate): CvExperienceStatus {
  if (candidate.hasMedicalRepExperience === true) return "experienced";
  if (candidate.hasMedicalRepExperience === false) return "fresh";
  return "unknown";
}

/**
 * Degree and faculty stay apart rather than joining into "Bachelor · Pharmacy".
 *
 * Joined, they were one line wide enough to keep the whole table scrolling sideways. Three short
 * lines cost vertical space, which this page has, instead of horizontal space, which it does not.
 */

/**
 * "Cairo University (2019)" — where they studied, and when.
 *
 * The year rides with the institution rather than the qualification because that is how a CV reads
 * it, and because a bare year on its own line would look like a stray number.
 */
function educationInstitution(candidate: Candidate): string {
  const university = text(candidate.university);
  const year = candidate.graduationYear;
  if (!university) return year ? String(year) : "";
  return year ? `${university} (${year})` : university;
}

/**
 * `questionLabels` is the current admin-defined question list (question_key -> body_text),
 * including retired ones — the same rows `listScreeningQuestions()` returns, in the admin's own
 * sort order. Map iteration order follows insertion order, so building it from that already-sorted
 * list is what keeps a candidate's answers in the same order the builder shows them. Defaults to
 * empty so this stays callable (and testable) without a question list at all.
 */
export function cvLibraryRowFromCandidate(
  candidate: Candidate,
  questionLabels: ReadonlyMap<string, string> = new Map(),
): CvLibraryRow {
  const months = medicalSalesMonths(candidate);
  const years = candidate.yearsExperience;
  // The recruitment pool's own resolver, not a second copy of the rule.
  const facts = candidateScreeningFacts(candidate);
  const screeningAnswers = Array.from(questionLabels.entries())
    .map(([key, label]) => ({ answer: text(candidate.screeningExtraAnswers[key]), label }))
    .filter((entry) => entry.answer.length > 0);
  // The background review's own verdict, not a re-reading of `faculty` — same reason the region
  // above comes from `candidateScreeningFacts` rather than being re-derived from the governorate.
  const background = judgeBackground({
    declaredBackground: candidate.declaredBackground,
    degree: candidate.degree,
    faculty: candidate.faculty,
  });
  return {
    backgroundOutcome: background.outcome,
    backgroundSource: background.source ?? null,
    cvFileName: text(candidate.cvReferenceName),
    currentEmployer: text(candidate.currentEmployer),
    appliedForJobTitle: text(candidate.appliedForJobTitle),
    currentJobTitle: text(candidate.currentJobTitle),
    education: educationLine(candidate),
    educationDegree: text(candidate.degree),
    educationFaculty: text(candidate.faculty),
    educationInstitution: educationInstitution(candidate),
    degreeGrade: normalizeDegreeGrade(candidate.grade),
    degreeGradeRaw: text(candidate.grade),
    governorate: text(candidate.governorate),
    graduationYear: typeof candidate.graduationYear === "number" ? candidate.graduationYear : null,
    id: candidate.id,
    preferredArea: text(facts.area?.value),
    regionCode: facts.region?.value.code ?? null,
    regionDeclared: facts.region?.value.declared ?? false,
    regionForeignCountry: text(facts.region?.value.foreignCountry),
    regionLabel: text(facts.region?.value.label),
    medicalSales: medicalSalesStatus(candidate),
    medicalSalesDuration: months === null ? "" : formatDurationMonths(months),
    medicalSalesEmployer: text(candidate.medicalRepEmployer),
    name: text(candidate.fullName),
    receivedOn: cairoDayKey(candidate.createdAt),
    screeningAnswers,
    totalExperience:
      years === null || years === undefined ? "" : formatDurationMonths(Math.round(Number(years) * 12)),
    yearsExperienceValue: years === null || years === undefined ? null : Number(years),
  };
}

export function cvLibraryRowsFromCandidates(
  candidates: readonly Candidate[],
  questionLabels: ReadonlyMap<string, string> = new Map(),
): CvLibraryRow[] {
  return candidates.map((candidate) => cvLibraryRowFromCandidate(candidate, questionLabels));
}

export function summarizeCvLibrary(rows: readonly CvLibraryRow[]): CvLibrarySummary {
  const employers = new Set<string>();
  let experienced = 0;
  let fresh = 0;
  let unknown = 0;
  let monthsTotal = 0;
  let monthsCounted = 0;

  for (const row of rows) {
    if (row.currentEmployer) employers.add(row.currentEmployer.toLowerCase());
    if (row.medicalSalesEmployer) employers.add(row.medicalSalesEmployer.toLowerCase());
    if (row.medicalSales === "experienced") experienced += 1;
    else if (row.medicalSales === "fresh") fresh += 1;
    else unknown += 1;

    const months = monthsFromDurationLabel(row.medicalSalesDuration);
    if (months !== null) {
      monthsTotal += months;
      monthsCounted += 1;
    }
  }

  return {
    averageExperienceMonths: monthsCounted === 0 ? 0 : Math.round(monthsTotal / monthsCounted),
    candidates: rows.length,
    employers: employers.size,
    experienced,
    fresh,
    unknown,
  };
}

/**
 * Reads "2 years 3 months" back to 27.
 *
 * The row carries the formatted label because that is what the table and the export both show;
 * averaging needs the number back. Parsing what formatDurationMonths produced keeps one definition
 * of the wording instead of carrying a second numeric field that could drift from it.
 */
function monthsFromDurationLabel(label: string): number | null {
  if (!label) return null;
  const years = /(\d+)\s*year/.exec(label);
  const months = /(\d+)\s*month/.exec(label);
  if (!years && !months) return null;
  return (years ? Number(years[1]) * 12 : 0) + (months ? Number(months[1]) : 0);
}
