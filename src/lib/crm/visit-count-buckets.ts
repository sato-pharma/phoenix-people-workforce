// THE AM · PM · PHARMACIES GOLDEN RULE (owner, 2026-09-21) — every count of CRM visits is three
// figures reported apart: AM (accounts), PM (doctors) and Pharmacies. A pharmacy visit is NEVER
// counted inside PM, and never inside AM either.
//
// Why a module of its own: iReports360 tags a pharmacy visit with an AM/PM period like any other —
// measured on production for 2026-08-01 to 2026-09-20, 1,827 regular pharmacy visits carried
// `ampm = 'PM'` and 426 carried 'AM' — so any count that buckets on `ampm` alone silently files
// pharmacies among the doctors.
//
// What makes a visit a pharmacy visit is the SAME test the call-rate board uses (isPharmacyVisit in
// call-rate.ts): the visited contact's own `speciality` ('pharmacy', sent on regular visits), or —
// for the vendor's undocumented -30 code, which carries no contact — the rep's comment, which
// classifyVisit already routes to "Pharmacy Visit". Two helpers, one answer.
//
// PHOENIX CRM LOGS NO PHARMACY VISIT (2026-10-02). From a team's start the visit door serves that
// team's Phoenix CRM visits instead of its iReports360 rows (src/lib/crm/phoenix-team-starts.ts), and
// a Phoenix customer is an AM account or a PM doctor only — a pharmacy there is stock feedback recorded
// ON a doctor's visit, never a visit of its own. So for a started team the Pharmacies figure is not a
// zero: it was never recorded. A split therefore knows how many of its rows came from Phoenix CRM
// (`phoenix`), and every printed figure says the truth through ONE set of words:
//   no Phoenix row            "AM 3 · PM 9 · Pharmacies 2"                      exactly as before
//   only Phoenix rows         "AM 3 · PM 9 · Pharmacies not recorded in Phoenix" never "Pharmacies 0"
//   both                      "AM 3 · PM 9 · Pharmacies 2 (iReports360 only)"   the vendor's count, named
// and a workbook cell is BLANK, never 0, with the same words in its note (`pharmacyCellValue`,
// `pharmacyCellNote`, `PHARMACY_CELL_FOOTNOTE`). Nothing here moves a pharmacy into AM or PM, invents a
// pharmacy count from Phoenix feedback, or changes any figure — only the words a figure is printed with.
//
// Pure — it imports only the pure CRM vocabularies and the one test of a Phoenix row — so the client
// components that print a count import it as readily as the server reads that build one. It is the ONE
// place that decides the bucket, and the ONE place that words a pharmacy figure Phoenix cannot give.

import { isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import { isPhoenixNativeVisitRow } from "@/lib/crm/phoenix-team-starts";
import { classifyVisit } from "@/lib/crm/visit-types";

export type VisitCountBucket = "AM" | "PM" | "Pharmacies";

export type VisitCountSplit = {
  am: number;
  pm: number;
  pharmacies: number;
  /**
   * How many of the visit rows behind this split are Phoenix CRM's own (`crm_visits_unified.source =
   * 'phoenix'`, a started team's visits). Phoenix CRM logs no pharmacy visit, so its rows only ever
   * reach AM and PM and `pharmacies` counts the iReports360 rows alone — see
   * {@link pharmacyRecordingOf}. Absent when none did: every `{ am, pm, pharmacies }` written before
   * 2026-10-02 means exactly what it did, and a split with no Phoenix row never carries the key.
   */
  phoenix?: number;
};

/**
 * The fields a visit row needs to be bucketed. `visit_type` and `comment` matter for -30 only;
 * `source` and `crm_visit_id` say whether the row is Phoenix CRM's own ({@link isPhoenixNativeVisitRow}:
 * `source = 'phoenix'`, or the NEGATIVE id the unified view gives every Phoenix row).
 */
export type VisitCountRow = {
  ampm?: string | null;
  comment?: string | null;
  crm_visit_id?: number | null;
  source?: string | null;
  speciality?: string | null;
  visit_type?: number | null;
  visit_type_description?: string | null;
};

export function isPharmacyVisitRow(row: VisitCountRow): boolean {
  if (isPharmacySpeciality(row.speciality)) return true;
  if (row.visit_type === undefined || row.visit_type === null) return false;
  return classifyVisit(row.visit_type, row.comment ?? null, row.visit_type_description ?? null).label === "Pharmacy Visit";
}

/**
 * The one bucket a visit is counted in. A pharmacy goes to Pharmacies whatever its period says;
 * otherwise an AM tag is AM and anything else — PM or an unmarked period — is PM, so every counted
 * visit lands in exactly one of the three.
 */
export function visitCountBucket(row: VisitCountRow): VisitCountBucket {
  if (isPharmacyVisitRow(row)) return "Pharmacies";
  return String(row.ampm ?? "").trim().toUpperCase().startsWith("A") ? "AM" : "PM";
}

export function emptyVisitCountSplit(): VisitCountSplit {
  return { am: 0, pm: 0, pharmacies: 0 };
}

/**
 * Adds `count` visits to one bucket. `fromPhoenix` says the visits are Phoenix CRM rows
 * ({@link isPhoenixNativeVisitRow}) — pass it wherever the row is in hand, so the split can say its
 * pharmacy figure was never recorded rather than print a zero.
 */
export function addBucketToSplit(split: VisitCountSplit, bucket: VisitCountBucket, count = 1, fromPhoenix = false): VisitCountSplit {
  if (bucket === "AM") split.am += count;
  else if (bucket === "PM") split.pm += count;
  else split.pharmacies += count;
  if (fromPhoenix && count !== 0) split.phoenix = (split.phoenix ?? 0) + count;
  return split;
}

export function addVisitToSplit(split: VisitCountSplit, row: VisitCountRow, count = 1): VisitCountSplit {
  return addBucketToSplit(split, visitCountBucket(row), count, isPhoenixNativeVisitRow(row));
}

export function mergeVisitCountSplits(target: VisitCountSplit, source: VisitCountSplit): VisitCountSplit {
  target.am += source.am;
  target.pm += source.pm;
  target.pharmacies += source.pharmacies;
  if (source.phoenix) target.phoenix = (target.phoenix ?? 0) + source.phoenix;
  return target;
}

export function visitCountSplitTotal(split: VisitCountSplit): number {
  return split.am + split.pm + split.pharmacies;
}

// ── The pharmacy figure Phoenix CRM cannot give ─────────────────────────────────────────────────

/**
 * Whether a split's pharmacy figure says what it seems to:
 *   recorded      no row behind it is Phoenix CRM's — the figure is the whole count, as always;
 *   not-recorded  every row is Phoenix CRM's and none was a pharmacy — there is no figure at all;
 *   partial       Phoenix rows sit beside iReports360 ones — the figure counts the iReports360 rows only.
 *
 * `fromVisits` judges a split that was DERIVED from visits rather than counting them (distinct
 * customers, say) by the visits it came from: its pharmacy figure is missing exactly when theirs is.
 */
export type PharmacyRecording = "recorded" | "not-recorded" | "partial";

export function pharmacyRecordingOf(split: VisitCountSplit, fromVisits?: VisitCountSplit | null): PharmacyRecording {
  const judged = fromVisits ?? split;
  const phoenix = Number(judged.phoenix ?? 0);
  if (!(phoenix > 0)) return "recorded";
  const nothingElse = judged.pharmacies <= 0 && phoenix >= judged.am + judged.pm;
  // A real pharmacy count is never hidden behind "not recorded", whatever the visits say.
  return nothingElse && split.pharmacies <= 0 ? "not-recorded" : "partial";
}

/** After "Pharmacies" when every row is Phoenix CRM's: "Pharmacies not recorded in Phoenix". */
export const PHARMACIES_NOT_RECORDED_IN_PHOENIX = "not recorded in Phoenix";

/** After the figure when Phoenix rows sit beside iReports360 ones: "Pharmacies 2 (iReports360 only)". */
export const PHARMACIES_IREPORTS360_ONLY = "(iReports360 only)";

/** Why, wherever a line of explanation has room. */
export const PHOENIX_LOGS_NO_PHARMACY_VISIT = "Phoenix CRM logs no pharmacy visit";

type PharmacyFigureOptions = {
  /** Judge a derived split (distinct customers) by the visits it came from. See {@link pharmacyRecordingOf}. */
  fromVisits?: VisitCountSplit | null;
  /** How the number is printed — a page's own thousands format, say. */
  formatNumber?: (value: number) => string;
};

/** The pharmacy figure without its label: "2", "not recorded in Phoenix" or "2 (iReports360 only)". */
export function pharmacyFigureText(split: VisitCountSplit, options: PharmacyFigureOptions = {}): string {
  const recording = pharmacyRecordingOf(split, options.fromVisits);
  if (recording === "not-recorded") return PHARMACIES_NOT_RECORDED_IN_PHOENIX;
  const figure = (options.formatNumber ?? String)(split.pharmacies);
  return recording === "partial" ? `${figure} ${PHARMACIES_IREPORTS360_ONLY}` : figure;
}

/** The figure standing alone, as a metric's value: "2", "Not recorded in Phoenix" or "2 (iReports360 only)". */
export function pharmacyValueText(split: VisitCountSplit, options: PharmacyFigureOptions = {}): string {
  const text = pharmacyFigureText(split, options);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The pharmacy part of a split, labelled: "Pharmacies 2", "Pharmacies not recorded in Phoenix" or
 * "Pharmacies 2 (iReports360 only)". `numberFirst` is for a page that writes its figures number first
 * ("12 AM · 30 PM · 5 Pharmacies"): "5 Pharmacies", "Pharmacies not recorded in Phoenix",
 * "5 Pharmacies (iReports360 only)". `label` is the page's own word for them ("pharmacies" mid-sentence).
 */
export function formatPharmacyFigure(
  split: VisitCountSplit,
  options: PharmacyFigureOptions & { label?: string; numberFirst?: boolean } = {},
): string {
  const label = options.label ?? "Pharmacies";
  const recording = pharmacyRecordingOf(split, options.fromVisits);
  if (recording === "not-recorded") return `${label} ${PHARMACIES_NOT_RECORDED_IN_PHOENIX}`;
  const value = (options.formatNumber ?? String)(split.pharmacies);
  const figure = options.numberFirst ? `${value} ${label}` : `${label} ${value}`;
  return recording === "partial" ? `${figure} ${PHARMACIES_IREPORTS360_ONLY}` : figure;
}

/**
 * For a tile or a table cell that prints the figure under a label of its own ("Pharmacy visits"): the
 * value, and the line under it when the figure is not the whole count — "2"; "Not recorded" with
 * "Phoenix CRM logs no pharmacy visit"; "2" with "iReports360 only".
 */
export function pharmacyTileFigure(split: VisitCountSplit, options: PharmacyFigureOptions = {}): { value: string; note: string | null } {
  const recording = pharmacyRecordingOf(split, options.fromVisits);
  if (recording === "not-recorded") return { value: "Not recorded", note: PHOENIX_LOGS_NO_PHARMACY_VISIT };
  const value = (options.formatNumber ?? String)(split.pharmacies);
  return { value, note: recording === "partial" ? "iReports360 only" : null };
}

/**
 * A workbook cell for the pharmacy figure: the count, or null — a BLANK cell, never 0 — when every row
 * behind it is Phoenix CRM's. Pair it with {@link pharmacyCellNote} and {@link PHARMACY_CELL_FOOTNOTE}.
 */
export function pharmacyCellValue(split: VisitCountSplit, fromVisits?: VisitCountSplit | null): number | null {
  return pharmacyRecordingOf(split, fromVisits) === "not-recorded" ? null : split.pharmacies;
}

/** The note a pharmacy cell carries when its figure is not the whole count; null when it is. */
export function pharmacyCellNote(split: VisitCountSplit, fromVisits?: VisitCountSplit | null): string | null {
  const recording = pharmacyRecordingOf(split, fromVisits);
  if (recording === "not-recorded") return `Pharmacies ${PHARMACIES_NOT_RECORDED_IN_PHOENIX} — blank, never 0.`;
  if (recording === "partial") return `Pharmacies ${PHARMACIES_IREPORTS360_ONLY} — ${PHOENIX_LOGS_NO_PHARMACY_VISIT}.`;
  return null;
}

/** Printed under every sheet that carries a pharmacy column — the outstation export's "Blank = …, never 0". */
export const PHARMACY_CELL_FOOTNOTE =
  "Pharmacies: blank = not recorded in Phoenix, never 0. Phoenix CRM logs no pharmacy visit (a pharmacy is " +
  "feedback on a doctor's visit there), so beside Phoenix CRM visits the figure counts the iReports360 visits only.";

/**
 * "AM 3 · PM 9 · Pharmacies 2" — the three figures apart, joined by a middle dot, never a slash
 * and never one combined number. `compact` drops a zero figure (a calendar chip has no room for
 * "AM 0"); the full form always prints all three. A pharmacy figure Phoenix CRM could not give is
 * never dropped and never a zero: "Pharmacies not recorded in Phoenix", or "Pharmacies 2
 * (iReports360 only)" beside iReports360 rows — see {@link pharmacyRecordingOf}.
 */
export function formatVisitCountSplit(
  split: VisitCountSplit,
  options: { compact?: boolean; fromVisits?: VisitCountSplit | null } = {},
): string {
  const parts: Array<[string, number]> = [
    ["AM", split.am],
    ["PM", split.pm],
  ];
  const shown = (options.compact ? parts.filter(([, value]) => value > 0) : parts).map(([label, value]) => `${label} ${value}`);
  const recording = pharmacyRecordingOf(split, options.fromVisits);
  if (!options.compact || recording !== "recorded" || split.pharmacies > 0) {
    shown.push(formatPharmacyFigure(split, { fromVisits: options.fromVisits }));
  }
  if (shown.length === 0) return "No visits";
  return shown.join(" · ");
}
