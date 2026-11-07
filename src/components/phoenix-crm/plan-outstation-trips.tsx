"use client";

import { CrmNote } from "@/components/phoenix-crm/ui";
import { type PlanOutstationTrip, planOutstationTripLine } from "@/lib/phoenix-crm/outstation-trip-banner";

/**
 * "On an outstation trip to X · dates" above a plan (owner, 2026-11-07: "Trip on the CRM side").
 * Narrowed to the days given, so a manager reviewing one week reads only that week's trips.
 * Information only: nothing on the plan is blocked or changed by it.
 */
export function PlanOutstationTrips({
  from,
  to,
  trips,
}: {
  from?: string;
  to?: string;
  trips: ReadonlyArray<PlanOutstationTrip> | undefined;
}) {
  const shown = (trips ?? []).filter((trip) => (!to || trip.from <= to) && (!from || trip.to >= from));
  if (shown.length === 0) return null;
  return (
    <CrmNote tone="info">
      <span className="block space-y-0.5" data-plan-outstation-trips>
        {shown.map((trip) => (
          <span className="block break-words" dir="auto" key={`${trip.from}-${trip.destination ?? ""}`}>
            {planOutstationTripLine(trip)}
          </span>
        ))}
      </span>
    </CrmNote>
  );
}
