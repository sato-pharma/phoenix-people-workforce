/**
 * The business trips of a territory's people inside a window, for the plan boards' banner
 * (`outstation-trip-banner.ts`). Read through `loadOutstationTripDays`, the one reader of trip days
 * — never a second query of the expense tables. A failed read gives no banner, never a failed board.
 */

import { loadOutstationTripDays } from "@/lib/outstation/trip-work-evidence";
import { foldPlanOutstationTrips, type PlanOutstationTrip } from "@/lib/phoenix-crm/outstation-trip-banner";
import { personKey } from "@/lib/phoenix-crm/scope";

export async function loadPeopleOutstationTrips(
  hrIds: ReadonlyArray<string>,
  window: { from: string; to: string },
): Promise<PlanOutstationTrip[]> {
  const wanted = new Set(hrIds.map((hrId) => personKey(hrId)).filter((key): key is string => Boolean(key)));
  if (wanted.size === 0) return [];
  try {
    const days = await loadOutstationTripDays({ end: window.to, start: window.from });
    return foldPlanOutstationTrips(days.filter((day) => wanted.has(personKey(day.hrId) ?? "")));
  } catch {
    return [];
  }
}
