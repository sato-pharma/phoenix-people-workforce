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
import { candidateScreeningFacts } from "@/lib/recruitment/candidate-screening-facts";
import { cairoDayKey } from "@/lib/recruitment/candidate-stats";
import type { Candidate } from "@/lib/recruitment/types";

export type CvLibraryRow = {
  id: string;
  name: string;
  /** The day the CV arrived, in Africa/Cairo — never a raw UTC timestamp. */
  receivedOn: string;
  currentJobTitle: string;
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
};

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

export function cvLibraryRowFromCandidate(candidate: Candidate): CvLibraryRow {
  const months = medicalSalesMonths(candidate);
  const years = candidate.yearsExperience;
  // The recruitment pool's own resolver, not a second copy of the rule.
  const facts = candidateScreeningFacts(candidate);
  return {
    cvFileName: text(candidate.cvReferenceName),
    currentEmployer: text(candidate.currentEmployer),
    currentJobTitle: text(candidate.currentJobTitle),
    education: educationLine(candidate),
    educationDegree: text(candidate.degree),
    educationFaculty: text(candidate.faculty),
    educationInstitution: educationInstitution(candidate),
    governorate: text(candidate.governorate),
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
    totalExperience:
      years === null || years === undefined ? "" : formatDurationMonths(Math.round(Number(years) * 12)),
  };
}

export function cvLibraryRowsFromCandidates(candidates: readonly Candidate[]): CvLibraryRow[] {
  return candidates.map(cvLibraryRowFromCandidate);
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
