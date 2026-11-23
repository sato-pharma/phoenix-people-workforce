"use client";

/**
 * Phoenix CRM — Place checks: the two lanes and the one waiting number, on the Super Admin's board.
 *
 * `place-check-lanes.ts` sorts and counts; this hands it the board's rows. The lanes are drawn from the
 * FILTERED rows, like every list on the page; the header's number is counted from the rows BEFORE the
 * filters, so it never moves with a filter and is the number Needs You shows.
 *
 * 🔴 A BOARD THAT DOES NOT DECIDE HAS NO LANES. The SFE Manager and a district manager are handed no
 * advice, so nothing is sorted for them: every waiting row is in the one list they always had.
 */

import { useMemo } from "react";

import { deskUnitsOf, laneOfReviewRow, laneOfVenueGroup, placeCheckDesk, yourCallReasons, type LaneReading } from "@/lib/phoenix-crm/place-check-lanes";
import type { PlaceCheckAgreement } from "@/lib/phoenix-crm/place-check-stored-advice";
import type { VenueGroup } from "@/lib/phoenix-crm/shared-place-groups";
import type { ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

export function usePlaceCheckLanes({
  agreement,
  clinicPending,
  everyVenueGroup,
  filteredPending,
  lanes,
  needsGroups,
  showWaiting,
}: {
  agreement: PlaceCheckAgreement | null;
  /** Every waiting clinic, before the filters. */
  clinicPending: ValidationReviewRow[];
  /** Every building, before the filters. */
  everyVenueGroup: VenueGroup[];
  filteredPending: ValidationReviewRow[];
  lanes: boolean;
  needsGroups: VenueGroup[];
  showWaiting: boolean;
}) {
  const sorted = useMemo(() => {
    const reviews = showWaiting ? filteredPending : [];
    if (!lanes) {
      return { readyReviews: [] as ValidationReviewRow[], callReviews: reviews, readyGroups: [] as VenueGroup[], callGroups: needsGroups, readings: [] as LaneReading[] };
    }
    const readyReviews: ValidationReviewRow[] = [];
    const callReviews: ValidationReviewRow[] = [];
    const readyGroups: VenueGroup[] = [];
    const callGroups: VenueGroup[] = [];
    const readings: LaneReading[] = [];
    for (const row of reviews) {
      const reading = laneOfReviewRow(row, agreement);
      readings.push(reading);
      (reading.lane === "ready" ? readyReviews : callReviews).push(row);
    }
    for (const group of needsGroups) {
      const reading = laneOfVenueGroup(group, agreement);
      readings.push(reading);
      (reading.lane === "ready" ? readyGroups : callGroups).push(group);
    }
    return { readyReviews, callReviews, readyGroups, callGroups, readings };
  }, [lanes, showWaiting, filteredPending, needsGroups, agreement]);

  // 🔴 THE ONE WAITING NUMBER IS COUNTED BEFORE THE FILTERS, in decisions: a clinic is one, a building is
  // one however many customers wait behind it (`placeCheckDesk`).
  const desk = useMemo(
    () => (lanes ? placeCheckDesk(deskUnitsOf({ clinics: clinicPending, groups: everyVenueGroup }, agreement)) : null),
    [lanes, clinicPending, everyVenueGroup, agreement],
  );
  /** Why the rows of Your call are his, the commonest reason first. */
  const reasons = useMemo(() => yourCallReasons(sorted.readings), [sorted.readings]);

  return { ...sorted, desk, reasons };
}
