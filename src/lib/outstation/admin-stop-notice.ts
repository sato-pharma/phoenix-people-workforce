/**
 * What the employee is told when HR adds a stop to their trip (owner, 2026-11-19: "AMR IS NOT INFORMED
 * WHY ?"). HR's "Add a missed stop" moves the person's money — a ticket joins the claim and payroll
 * follows the new total — so the person hears it, by in-app, Telegram and email (his choice of the
 * three). The service sends it (notifyEmployeeOfAdminJourneyStop); this file holds the words, pure.
 */

import { formatPhoenixDateTime, formatPhoenixLongDate } from "@/lib/i18n/format";
import { tidyOutstationAddress } from "@/lib/outstation/description-format";

export type AdminStopNoticeStop = {
  addedByAdmin?: { by: string; reason: string } | null;
  capturedAt: string;
  governorate: string | null;
  locationLabel: string | null;
  stopNumber: number;
  ticketAmount: number;
};

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** The same EGP shape as every outstation notice. */
function formatNoticeEgp(value: number): string {
  return `${Number(value || 0).toLocaleString("en-EG", { maximumFractionDigits: 2 })} EGP`;
}

/** The place a person recognises: the governorate, else the tidied address. */
export function adminStopPlace(stop: Pick<AdminStopNoticeStop, "governorate" | "locationLabel">): string {
  return clean(stop.governorate) || tidyOutstationAddress(stop.locationLabel) || "a new place";
}

/** One sentence the bell, Telegram and the email all carry: where, when, the leg's ticket, the new total, why. */
export function adminJourneyStopNoticeMessage(input: {
  claimedTotal: number;
  stop: AdminStopNoticeStop;
  tripEndDate: string;
  tripStartDate: string;
}): string {
  const ticket = input.stop.ticketAmount > 0 ? ` with its ticket of ${formatNoticeEgp(input.stop.ticketAmount)}` : "";
  const reason = clean(input.stop.addedByAdmin?.reason);
  return (
    `HR added stop ${input.stop.stopNumber}, ${adminStopPlace(input.stop)}, to your trip of ` +
    `${formatPhoenixLongDate(input.tripStartDate)} to ${formatPhoenixLongDate(input.tripEndDate)}, at ` +
    `${formatPhoenixDateTime(input.stop.capturedAt)}${ticket}. Your claim is now ${formatNoticeEgp(input.claimedTotal)}.` +
    (reason ? ` Reason: ${reason}` : "")
  );
}

/** Told once per stop: the trip, the stop number and the person. */
export function adminStopNoticeKey(requestId: number | string, stopNumber: number, employeeHrId: string): string {
  return `outstation:${requestId}:journey_stop_added_by_hr:${stopNumber}:${employeeHrId.trim().toUpperCase()}`;
}
