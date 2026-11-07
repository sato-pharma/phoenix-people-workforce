/**
 * A TRAIN TICKET IS READ WHEN IT IS ATTACHED, AND ITS DATE MUST MATCH THE TRIP'S PHOTOS (owner, 2026-11-07:
 * "if someone choose that travel is train, when he capture or upload the ticket the ticket is scanned and
 * date is checked in arrival or departure photo; if cannot read, not accept the ticket and tell them why" —
 * and "tell him zoom in or out, centre the ticket; the system tells them what he really needs to be able to
 * read the ticket").
 *
 * Pure and client-safe: the wizard and the missing-ticket card judge with it the moment a file is picked,
 * and the server judges again with the same function before it stores the file.
 *
 *  - What has to be read: the TRAVEL DATE printed on the ticket. Without it the ticket is refused.
 *  - The date must be the ARRIVAL photo's day, or the day before it (a night train arrives the next
 *    morning) — the outbound ticket; or the DEPARTURE photo's day — the return ticket. Before the departure
 *    photo is taken, the trip's last day stands in for it (that is the day it is owed). With no arrival
 *    photo (the roles that take none), the trip's first day stands in for the arrival.
 *  - A refusal always says why, and an unreadable photo says what to change: zoom in or out, centre the
 *    ticket, steady, light, glare, straight.
 *  - Train only. A bus ticket is not read (the owner named the train).
 *  - When the reader itself cannot be reached, the ticket is KEPT and marked "not read" — an employee is
 *    never refused for the system's own outage.
 */

export type TicketScanProblem =
  | "too_far"
  | "too_close"
  | "cut_off"
  | "blurry"
  | "dark"
  | "glare"
  | "rotated"
  | "date_hidden"
  | "not_a_ticket";

export const TICKET_SCAN_PROBLEMS: readonly TicketScanProblem[] = [
  "too_far",
  "too_close",
  "cut_off",
  "blurry",
  "dark",
  "glare",
  "rotated",
  "date_hidden",
  "not_a_ticket",
];

/** What the employee should do about each problem — an instruction, never a diagnosis. */
export const TICKET_SCAN_GUIDANCE: Record<TicketScanProblem, string> = {
  blurry: "Hold the phone still and tap the screen on the ticket so it focuses before you take the photo.",
  cut_off: "Centre the ticket in the photo so none of its four edges is cut off.",
  dark: "Take the photo in more light.",
  date_hidden: "Make sure the travel date on the ticket is in the photo and not covered by a finger or a fold.",
  glare: "Tilt the ticket or the phone so no light reflects on it.",
  not_a_ticket: "This does not look like a train ticket. Take the photo of the ticket itself.",
  rotated: "Hold the ticket straight and the right way up.",
  too_close: "Zoom out or move the phone back — the whole ticket must fit in the photo.",
  too_far: "Zoom in or move the phone closer — the ticket should fill most of the photo.",
};

/** What the system needs from a ticket photo, said before and after every refusal. */
export const TICKET_SCAN_NEEDS =
  "To accept a train ticket the system must read its travel date. Keep the whole ticket in the photo, sharp and well lit, with the date, the stations and the train number clear.";

export type TicketScanRead =
  | {
      status: "read";
      /** YYYY-MM-DD as printed on the ticket. */
      travelDate: string;
      fromStation: string | null;
      toStation: string | null;
      trainNumber: string | null;
    }
  | { status: "unreadable"; problems: TicketScanProblem[] }
  /** The reader could not be reached; the ticket is kept, marked "not read". */
  | { status: "unavailable" };

export type TicketDateContext = {
  /** The arrival photo's own time (ISO), or null when none was taken. */
  arrivalAt: string | null;
  /** The departure photo's time (ISO), or null while it is not taken yet. */
  departureAt: string | null;
  /** The trip's first and last day, YYYY-MM-DD. */
  tripStartDate: string;
  tripEndDate: string;
};

export type TicketVerdict =
  | { accepted: true; travelDate: string | null; matchedTo: "arrival" | "departure" | "not_read"; line: string }
  | { accepted: false; reason: string; guidance: string[] };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The Cairo calendar day of an ISO instant, or of a bare YYYY-MM-DD. */
export function cairoDay(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (ISO_DAY.test(raw)) return raw;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(
    new Date(time),
  );
}

function shiftDay(day: string, by: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

/** "Fri 23 Oct 2026" — the date as the employee reads it on the screen. */
export function ticketDayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC", weekday: "short", year: "numeric" }).format(date);
}

/** Only a train ticket is read. */
export function ticketScanApplies(transportationType: string | null | undefined): boolean {
  return String(transportationType ?? "").toLowerCase() === "train";
}

/** A model's answer, made safe: a date only when it is a real YYYY-MM-DD, problems only from the known list. */
export function normalizeTicketScan(raw: Record<string, unknown>): TicketScanRead {
  const date = String(raw.travel_date ?? "").trim();
  const real = ISO_DAY.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && shiftDay(date, 0) === date;
  const text = (value: unknown) => {
    const out = String(value ?? "").trim();
    return out ? out : null;
  };
  if (raw.is_train_ticket !== false && real) {
    return { fromStation: text(raw.from_station), status: "read", toStation: text(raw.to_station), trainNumber: text(raw.train_number), travelDate: date };
  }
  const problems = (Array.isArray(raw.problems) ? raw.problems : [])
    .map((entry) => String(entry))
    .filter((entry): entry is TicketScanProblem => (TICKET_SCAN_PROBLEMS as readonly string[]).includes(entry));
  if (raw.is_train_ticket === false && !problems.includes("not_a_ticket")) problems.unshift("not_a_ticket");
  if (problems.length === 0) problems.push("date_hidden");
  return { problems: [...new Set(problems)], status: "unreadable" };
}

/** The verdict on one ticket: read, and its date one the trip's photos allow. */
export function judgeTrainTicket(scan: TicketScanRead, context: TicketDateContext): TicketVerdict {
  if (scan.status === "unavailable") {
    return { accepted: true, line: "Attached — it could not be read just now, so the approver checks it by eye.", matchedTo: "not_read", travelDate: null };
  }
  if (scan.status === "unreadable") {
    return {
      accepted: false,
      guidance: scan.problems.map((problem) => TICKET_SCAN_GUIDANCE[problem]),
      reason: scan.problems.includes("not_a_ticket")
        ? "Not accepted: this is not a train ticket the system can read."
        : "Not accepted: the system could not read the travel date on this ticket.",
    };
  }

  const arrivalDay = cairoDay(context.arrivalAt) ?? cairoDay(context.tripStartDate);
  const departureDay = cairoDay(context.departureAt) ?? cairoDay(context.tripEndDate);
  const arrivalWord = context.arrivalAt ? "your arrival photo" : "the trip's first day";
  const departureWord = context.departureAt ? "your departure photo" : "the trip's last day";
  const travel = scan.travelDate;
  const route = [scan.fromStation, scan.toStation].filter(Boolean).join(" to ");
  const described = `${ticketDayLabel(travel)}${route ? ` · ${route}` : ""}${scan.trainNumber ? ` · train ${scan.trainNumber}` : ""}`;

  if (arrivalDay && (travel === arrivalDay || travel === shiftDay(arrivalDay, -1))) {
    return { accepted: true, line: `Ticket read: ${described} — matches ${arrivalWord}.`, matchedTo: "arrival", travelDate: travel };
  }
  if (departureDay && travel === departureDay) {
    return { accepted: true, line: `Ticket read: ${described} — matches ${departureWord}.`, matchedTo: "departure", travelDate: travel };
  }
  const allowed = [arrivalDay ? `${ticketDayLabel(arrivalDay)} (${arrivalWord})` : null, departureDay ? `${ticketDayLabel(departureDay)} (${departureWord})` : null]
    .filter(Boolean)
    .join(" or ");
  return {
    accepted: false,
    guidance: ["Attach the ticket of this trip — the one you travelled on to arrive or to come back."],
    reason: `Not accepted: the ticket is dated ${ticketDayLabel(travel)}, but this trip's travel days are ${allowed}.`,
  };
}

/** What the server keeps on the claim for each train ticket — the approver reads it beside the file. */
export type OutstationTicketScanRecord = {
  matchedTo: "arrival" | "departure" | "not_read";
  travelDate: string | null;
  fromStation: string | null;
  toStation: string | null;
  trainNumber: string | null;
  line: string;
};

/** The one sentence a refused ticket raises: why, then what to do, then what the system needs. */
export function ticketRefusalMessage(verdict: Extract<TicketVerdict, { accepted: false }>): string {
  return [verdict.reason, ...verdict.guidance, TICKET_SCAN_NEEDS].join(" ");
}
