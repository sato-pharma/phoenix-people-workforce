/**
 * Only an overnight stay may join two calendar days into one trip (owner rule, 2026-09-18).
 *
 * The wizard derives "overnight" from nothing but the two dates the employee types: any From Date
 * earlier than the To Date is priced as nights away plus a return day. Nothing checked that the
 * employee was actually away on the first day. On 2026-08-24/25 one employee filed a single trip
 * From 24 To 25 at 11:53 on the 25th; both of its photos, arrival and departure, were taken on the
 * 25th, 1.4 km apart. It was paid as "Overnight / 2 days" and the owner found no photo for the
 * 24th, because none was ever taken — two days had been joined by the dates alone.
 *
 * The arrival photo is taken when the employee arrives, so on a real overnight stay it falls on the
 * trip's FIRST day. One dated later is the shape of a same-day return (or of separate day trips)
 * written as a stay. That is FLAGGED, never refused — the owner's 2026-08-09 flag-never-reject rule:
 * a genuine stay filed on its last day (a training week filed on the Thursday) has the same shape,
 * and the system cannot tell the two apart. The claim is held with this reason on it, so the person
 * deciding it reads exactly what is missing.
 *
 * Pure: no database, no clock.
 */

import { cairoDateOnly } from "@/lib/outstation/departure-evidence";

function dateOnly(value: string | null | undefined): string | null {
  const day = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function readableDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });
}

/**
 * The hold reason for a multi-day trip whose arrival photo was taken after the trip's first day,
 * Cairo time — or null when the trip is one day, carries no dated arrival photo (a waived role, an
 * admin-created expense), or the photo falls on the first day as a stay's should.
 */
export function overnightStayEvidenceHoldReason(input: {
  arrivalCapturedAt: string | null | undefined;
  tripEndDate: string | null | undefined;
  tripStartDate: string | null | undefined;
}): string | null {
  const firstDay = dateOnly(input.tripStartDate);
  const lastDay = dateOnly(input.tripEndDate);
  if (!firstDay || !lastDay || lastDay <= firstDay) return null;

  const arrivalDay = cairoDateOnly(input.arrivalCapturedAt);
  if (!arrivalDay || arrivalDay <= firstDay) return null;

  return (
    `This trip joins ${readableDay(firstDay)} to ${readableDay(lastDay)} as an overnight stay, but its arrival photo ` +
    `was taken on ${readableDay(arrivalDay)}, so nothing shows the employee was away on ${readableDay(firstDay)}. ` +
    "Only an overnight stay spans two days; a same-day return is one trip per day. It is held for Super Admin review before it moves to payroll."
  );
}
