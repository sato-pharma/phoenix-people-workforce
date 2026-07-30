/**
 * Pure, client-safe helpers for interpreting a Field Workforce day cell on the employee-portal
 * Team Calendar. Kept free of any server import so the "use client" calendar view and the unit
 * tests can both consume them.
 *
 * Background: the shared Field Workforce engine credits a double-visit (ride-along) to BOTH the
 * primary rep AND the manager who rode along, so a manager's calendar day shows a visit count made
 * up of the reps' visits — the same visits already shown on the reps' own rows. On the Team
 * Calendar that reads as "doubled" data. These helpers make the portal show each person's OWN
 * (primary-agent) visits as the number, and render a pure ride-along day as a distinct "DV"
 * coaching marker instead. `ownVisitCount` is populated only on the live CRM-mirror path (see
 * buildFieldWorkforceCompliancePreviewFromVisitsReport); when it is absent (Excel-upload path) the
 * helpers fall back to the raw classified count, preserving prior behaviour.
 */

import type { FieldWorkforceDayCell } from "@/lib/field-workforce-compliance/types";

type PortalDayCell = Pick<FieldWorkforceDayCell, "status" | "ownVisitCount" | "visitCount">;

/**
 * The visit number the portal shows for a day: the person's OWN (primary-agent) regular visits,
 * NOT a total inflated by ride-along (double-visit) credit. Falls back to the raw classified count
 * when the own-count signal is unavailable (Excel-upload path).
 */
export function portalOwnVisitCount(cell: PortalDayCell): number {
  return cell.ownVisitCount ?? cell.visitCount ?? 0;
}

/**
 * A "double-visit / coaching" day: the day is classified as a worked VISITS day purely from
 * ride-along (double-visit) credit — the person logged zero of their own primary visits. The
 * portal renders these with a distinct "DV" marker instead of a numeric count so a manager's row
 * never duplicates the visit counts of the reps they rode along with. False when the own-count
 * signal is absent (Excel path), so nothing changes on that path.
 */
export function isPortalRideAlongCoachingDay(cell: PortalDayCell): boolean {
  return cell.status === "VISITS" && cell.ownVisitCount === 0;
}
