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
// AND THE CUSTOMER'S OWN LIST, which is how a PHOENIX pharmacy call says so. Phoenix CRM carries the
// list in `list_type`, the view hands it over as `ampm`, and `Pharmacy` is one of its three values
// (src/lib/phoenix-crm/pharmacy-call-rules.ts, rule 1) — so a row tagged `ampm = 'Pharmacy'` is a
// pharmacy whatever its speciality says. Reading only the speciality filed a Phoenix pharmacy call whose
// customer had none among the PM DOCTORS, which is the mistake `doctorListType` was written to stop
// ("not a refusal but a wrong answer"): measured on production 2026-10-04, 5 of Delta (1)'s 25 pharmacy
// calls of 3 October — three of B-158's, two of B-100's — were counted as PM doctor calls, against the
// rule that a pharmacy call is in NO KPI. No iReports360 row has ever carried `ampm = 'Pharmacy'`
// (0 of 139,369 measured the same day), so reading the list restates no vendor history at all.
//
// PHOENIX CRM RECORDS PHARMACY CALLS — since the owner's ruling of 2026-10-03, and this module said the
// opposite until 2026-10-04. It used to be true that a pharmacy existed there only as stock feedback
// typed ON a doctor's visit, so a started team's Pharmacies figure was worded "not recorded in Phoenix"
// rather than printed as 0, and a workbook cell was left BLANK. Then he ruled that a pharmacy named on a
// visit counts as that pharmacy's own visit, needing no validation, no plan and no approval; Delta (1)
// logged 25 on its first Phoenix day. So a Phoenix split's pharmacy figure is a REAL count again:
// `pharmacyRecordingOf` answers "recorded" for every split, and the three sets of words below are
// retired rather than deleted — the helpers still print the plain figure, so no caller changed, and the
// constants stay only so that nothing re-adopts a claim that is no longer true.
//
// Pure — it imports only the pure CRM vocabularies, the one test of a Phoenix row and the one parser of
// a Phoenix list — so the client components that print a count import it as readily as the server reads
// that build one. It is the ONE place that decides the bucket.

import { isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import { isPhoenixNativeVisitRow } from "@/lib/crm/phoenix-team-starts";
import { classifyVisit } from "@/lib/crm/visit-types";
import { isPharmacyListType } from "@/lib/phoenix-crm/pharmacy-call-rules";

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
  // The customer's own list, which is what a Phoenix pharmacy call carries — before the speciality,
  // because a rep adding a pharmacy at the door often leaves that field empty.
  if (isPharmacyListType(row.ampm)) return true;
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
 * Whether a split's pharmacy figure says what it seems to. ALWAYS "recorded" since the owner's ruling of
 * 2026-10-03: Phoenix CRM records a pharmacy call of its own, so every split's pharmacy figure is the
 * whole count, a 0 means nobody called a pharmacy, and the other two verdicts became false statements —
 *   not-recorded  claimed "Phoenix CRM logs no pharmacy visit" of a team that logged 25 on its first day;
 *   partial       claimed the figure counted the iReports360 rows only, when it counts both sources.
 *
 * Kept as the one gate rather than deleted at thirteen call sites: every helper below asks it, so one
 * answer here is what puts the real number back on every screen, export and workbook cell at once. A
 * started team's Pharmacies figure is a count again — it is no longer blanked, and no longer footnoted.
 *
 * `fromVisits` judged a derived split (distinct customers, say) by the visits it came from; it is still
 * accepted so no caller had to change, and it no longer alters the answer.
 */
export type PharmacyRecording = "recorded" | "not-recorded" | "partial";

export function pharmacyRecordingOf(_split: VisitCountSplit, _fromVisits?: VisitCountSplit | null): PharmacyRecording {
  return "recorded";
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
