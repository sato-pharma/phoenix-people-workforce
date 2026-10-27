/**
 * Phoenix CRM — a manager's own single visit as a Visit report row (owner, 2026-10-20, multiple choice: "Show, keep
 * out of reps — his own visits appear under his name in the Visit Report and the Field Activity day, never in a
 * rep's totals. Still no GPS or photo required").
 *
 * The row is built from the display record `manager-plan-readers.ts` hands out (`loadManagerOwnVisitRows`), never
 * from the table itself. Pure: no I/O, so a test proves exactly what such a row may and may not say.
 *
 * 🔴 WHAT IT NEVER SAYS. No distance, no "far from the place", no weak signal, no photo yes/no, no pin, no integrity
 *    verdict, no approval stage and no day-around-the-visit fact: his own visit is asked for none of them (owner,
 *    2026-10-20: a manager's own visit never requires GPS or a live photo), so each of those fields is BLANK on his
 *    row — never a "No" that reads as something he failed to do.
 * 🔴 WHOSE ROW IT IS. His, by name: `repName` and the only participant are the manager. It names no rep, so the
 *    report's rep list and every per-rep figure stay exactly as they were, and `ownVisit` keeps it out of the
 *    dashboard's figures.
 */

import { managerVisitWhereLines, type ManagerDayVisit } from "@/lib/phoenix-crm/manager-visit-detail";
import { dayOfWeekName, monthLabel } from "@/lib/phoenix-crm/visit-report-compute";
import type { VisitReportField, VisitReportRow, VisitReportValue } from "@/lib/phoenix-crm/visit-report-fields";

/** The visit type his row reads as — never "Single visit", the words a rep's own visit is counted under. */
export const MANAGER_OWN_VISIT_TYPE = "Manager's own visit";

/** The fields his own visit can fill. Every other field of the catalogue is blank on his row. */
export const MANAGER_OWN_VISIT_FIELDS = [
  "visitDate",
  "dayOfWeek",
  "month",
  "savedAt",
  "visitType",
  "plannedOrNot",
  "repName",
  "customerName",
  "speciality",
  "grade",
  "placeLabel",
  "placeAddress",
  "brick",
  "area",
  "productsDetailed",
  "comment",
] as const;

function blankToNull(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text ? text : null;
}

/** Every value his own visit carries, keyed by the catalogue's field key. */
export function managerOwnVisitValues(visit: ManagerDayVisit, managerName: string): Record<string, VisitReportValue> {
  // On a With my manager half-day the row names who went with him (owner, 2026-10-27) — still his own row.
  const senior = visit.kind === "with_senior" ? visit.withPeople[0]?.name : null;
  const typed = senior ? `${MANAGER_OWN_VISIT_TYPE} · with ${senior}` : MANAGER_OWN_VISIT_TYPE;
  const type = visit.inVacantTerritory ? `${typed} · vacant area` : typed;
  return {
    area: blankToNull(visit.areaName),
    brick: blankToNull(visit.brickName),
    comment: blankToNull(visit.comment),
    customerName: blankToNull(visit.customerName),
    dayOfWeek: dayOfWeekName(visit.date) || null,
    grade: blankToNull(visit.grade),
    month: monthLabel(visit.date) || null,
    placeAddress: blankToNull(visit.address),
    placeLabel: blankToNull(visit.placeLabel),
    plannedOrNot: visit.planned ? "Planned" : "Unplanned",
    productsDetailed: visit.products.length > 0 ? visit.products.join(", ") : null,
    repName: managerName,
    savedAt: blankToNull(visit.loggedAt),
    speciality: blankToNull(visit.speciality),
    visitDate: visit.date,
    visitType: type,
  };
}

/**
 * His own visit as a report row, holding ONLY the chosen fields (blank where his visit has nothing to say), with no
 * position of any kind: `visitLat`, `visitLon`, `distanceMeters` and `locationFlag` are null on every one.
 */
export function managerOwnVisitReportRow(
  visit: ManagerDayVisit,
  managerName: string,
  fields: ReadonlyArray<Pick<VisitReportField, "key">>,
): VisitReportRow {
  const all = managerOwnVisitValues(visit, managerName);
  const values: Record<string, VisitReportValue> = {};
  for (const field of fields) values[field.key] = all[field.key] ?? null;
  const where = managerVisitWhereLines(visit).join(", ");
  return {
    customerName: blankToNull(visit.customerName) ?? "Unknown customer",
    distanceMeters: null,
    listType: "",
    locationFlag: null,
    ownVisit: true,
    participants: [managerName],
    placeLabel: blankToNull(visit.placeLabel) ?? blankToNull(where),
    placeLat: null,
    placeLon: null,
    planned: visit.planned,
    repName: managerName,
    savedAtIso: visit.loggedAt ?? "",
    values,
    visitDate: visit.date,
    visitId: visit.id,
    visitLat: null,
    visitLon: null,
    visitType: all.visitType as string,
  };
}
