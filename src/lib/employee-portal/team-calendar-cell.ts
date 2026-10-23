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

import { emptyVisitCountSplit, mergeVisitCountSplits, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import type { FieldWorkforceDayCell, FieldWorkforceEmployeeSummary } from "@/lib/field-workforce-compliance/types";
import { canonicalHrIdKey } from "@/lib/hr-id";

type PortalDayCell = Pick<FieldWorkforceDayCell, "status" | "ownVisitCount" | "visitCount">;
type PortalSplitCell = PortalDayCell & Pick<FieldWorkforceDayCell, "managerOwnSplit" | "ownVisitSplit" | "rideAlongSplit">;

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

// ── The square's three figures (owner, 2026-10-23) ─────────────────────────────────────────────────────────────────
//
// *"In team calendar … you will make the square, for example, see 295, 2 for AM, 9 for PM, and 5 for pharmacies. Okay,
// same for district managers, and same in everywhere."* A day prints its AM, PM and Pharmacies figures apart — never
// added — and a manager's day carries every record that is his: his own visits in the mirror, his own Phoenix CRM single
// visits (`managerOwnSplit`), and, on a day he only rode along, the split of the visits he joined.

function hasAny(split: VisitCountSplit | undefined | null): split is VisitCountSplit {
  return Boolean(split && split.am + split.pm + split.pharmacies > 0);
}

/**
 * The AM · PM · Pharmacies figures the square prints, or null when the day has none to print (the Excel-upload path,
 * a day with no call, a campaign or leave day) — the square then keeps its old one-word label.
 */
export function portalDaySplit(cell: PortalSplitCell): VisitCountSplit | null {
  const own = emptyVisitCountSplit();
  if (cell.status === "VISITS") {
    // His own calls first; a pure ride-along day shows the calls he joined instead, so a manager's row never adds the
    // reps' visits on top of his own (the "doubled" data the DV marker was made against).
    if (hasAny(cell.ownVisitSplit)) mergeVisitCountSplits(own, cell.ownVisitSplit);
    else if (isPortalRideAlongCoachingDay(cell) && hasAny(cell.rideAlongSplit)) mergeVisitCountSplits(own, cell.rideAlongSplit);
  }
  if (hasAny(cell.managerOwnSplit)) mergeVisitCountSplits(own, cell.managerOwnSplit);
  return hasAny(own) ? { am: own.am, pharmacies: own.pharmacies, pm: own.pm } : null;
}

/** A day whose only work is the manager's own Phoenix CRM single visits — the mirror alone would read it as nothing. */
export function isManagerOwnVisitsOnlyDay(cell: PortalSplitCell): boolean {
  return cell.status !== "VISITS" && hasAny(cell.managerOwnSplit);
}

/**
 * Hangs each manager's own Phoenix CRM single visits on his day cells. Pure: the days come from
 * `loadManagerOwnVisitDays`, the only door out of that table. A day off the timeline is dropped, never invented.
 */
export function attachManagerOwnVisitSplits<T extends FieldWorkforceEmployeeSummary>(
  employees: readonly T[],
  days: ReadonlyArray<{ hrId: string; date: string; split?: VisitCountSplit }>,
): T[] {
  const byKey = new Map<string, VisitCountSplit>();
  for (const day of days) {
    const key = canonicalHrIdKey(day.hrId);
    if (!key || !hasAny(day.split)) continue;
    const at = `${key}|${day.date}`;
    byKey.set(at, mergeVisitCountSplits(byKey.get(at) ?? emptyVisitCountSplit(), day.split));
  }
  if (byKey.size === 0) return [...employees];
  return employees.map((employee) => {
    const key = canonicalHrIdKey(employee.hrId);
    if (!key) return employee;
    let touched = false;
    const timeline = employee.timeline.map((cell) => {
      const split = byKey.get(`${key}|${cell.dateIso}`);
      if (!split) return cell;
      touched = true;
      return { ...cell, managerOwnSplit: split };
    });
    return touched ? { ...employee, timeline } : employee;
  });
}
