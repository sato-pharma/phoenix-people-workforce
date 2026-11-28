/**
 * Does a train or bus claim that claims a RETURN fare carry the return ticket? (owner, 2026-11-23: "the
 * return ticket is asked for with the departure photo".)
 *
 * Why: from 7 Nov every train and bus ticket is read (ticket-scan.ts), but only the tickets the employee
 * chose to attach. On 23 Nov all 9 train claims filed since then claimed a return fare, and none carried
 * a return ticket that had been read — the outbound ticket proved the trip there and the return was paid
 * on the employee's word.
 *
 * What counts as the return ticket, read from the stored `scan` of each attached ticket:
 *   - a read ticket the reader matched to the DEPARTURE (dated the departure photo's day, or a later day
 *     of the trip than the arrival — ticket-scan-rules.ts);
 *   - or two read tickets, one each way. A same-day trip's return is dated the arrival day, so the reader
 *     matches it to the arrival; the second read ticket is still the second leg. When both carry their
 *     stations, the legs must run opposite ways — two copies of the outbound are not a return.
 *
 * Pure: the claim form, My claims and the desk read the same answer.
 */

export type ReturnTicketState =
  /** No return fare is claimed, so no return ticket is owed. */
  | "not_claimed"
  /** A return ticket was read. */
  | "present"
  /** A return fare is claimed, the tickets were read, and none of them is the return. */
  | "missing"
  /** A return fare is claimed, but no ticket was read (filed before 7 Nov, or the reader was down). */
  | "unread";

export type StoredScan = {
  fromStation?: unknown;
  matchedTo?: unknown;
  toStation?: unknown;
  travelDate?: unknown;
};

const station = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(station|railway|train|bus)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function readScans(tickets: unknown): StoredScan[] {
  if (!Array.isArray(tickets)) return [];
  return tickets
    .map((ticket) => (ticket && typeof ticket === "object" ? (ticket as { scan?: unknown }).scan : null))
    .filter((scan): scan is StoredScan => Boolean(scan) && typeof scan === "object")
    .filter((scan) => scan.matchedTo === "arrival" || scan.matchedTo === "departure");
}

/** True when two legs carry their stations and run the same way — a copy, not a return. */
function sameWay(left: StoredScan, right: StoredScan): boolean {
  const [a, b, c, d] = [left.fromStation, left.toStation, right.fromStation, right.toStation].map(station);
  if (!a || !b || !c || !d) return false;
  return a === c && b === d;
}

export function returnTicketState(input: { returnAmount: number | null | undefined; tickets: unknown; transportation: unknown }): ReturnTicketState {
  const transport = String(input.transportation ?? "").trim().toLowerCase();
  const amount = Number(input.returnAmount ?? 0);
  if ((transport !== "train" && transport !== "bus") || !(Number.isFinite(amount) && amount > 0)) return "not_claimed";
  const read = readScans(input.tickets);
  if (read.length === 0) return "unread";
  if (read.some((scan) => scan.matchedTo === "departure")) return "present";
  for (let left = 0; left < read.length; left += 1) {
    for (let right = left + 1; right < read.length; right += 1) {
      if (!sameWay(read[left], read[right])) return "present";
    }
  }
  return "missing";
}

/** "EGP 90" — the return fare, as the employee and the approver read it. */
export function returnFareLabel(amount: number): string {
  return `EGP ${Math.round(amount * 100) / 100}`;
}

/** "Thu 19 Nov 2026" — a ticket's date as the employee reads it. */
function legDayLabel(day: unknown): string | null {
  const iso = String(day ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC", weekday: "short", year: "numeric" }).format(date);
}

const stationText = (value: unknown) => {
  const out = String(value ?? "").trim();
  return out ? out : null;
};

/** The one read leg already on a claim whose other leg is owed — what the card names. */
export type LegOnClaim = { day: string | null; fromStation: string | null; toStation: string | null };

/** The read leg already on the claim (the first one), or null when none was read. */
export function legOnClaim(tickets: unknown): LegOnClaim | null {
  const [first] = readScans(tickets);
  if (!first) return null;
  return { day: legDayLabel(first.travelDate), fromStation: stationText(first.fromStation), toStation: stationText(first.toStation) };
}

/**
 * A ticket picked for the missing second leg that runs the SAME WAY as the one already on the claim is refused
 * (owner, 2026-11-28, after Weaam Gweed attached the same Cairo → Luxor photo three times over 23–25 Nov and the
 * same Sohag → Hurghada ticket twice: each was taken, the screen said "Return ticket attached", and the card came
 * back the next visit because two copies of one leg are not a return). Refused at the pick, with the leg named and
 * the way it must run instead, so she knows on the spot which ticket is wanted.
 *
 * Only a READ ticket is refused: one the reader could not reach is kept for the approver, as everywhere else.
 * Returns null when nothing is wrong — no return owed, or the picked tickets supply the other leg.
 */
export function sameLegAgainRefusal(input: {
  candidates: ReadonlyArray<StoredScan | null | undefined>;
  returnAmount: number | null | undefined;
  tickets: unknown;
  transportation: unknown;
}): { guidance: string[]; reason: string } | null {
  const base = { returnAmount: input.returnAmount, transportation: input.transportation };
  if (returnTicketState({ ...base, tickets: input.tickets }) !== "missing") return null;
  const candidates = input.candidates.filter((scan): scan is StoredScan => Boolean(scan));
  if (candidates.length === 0) return null;
  if (!candidates.every((scan) => scan.matchedTo === "arrival" || scan.matchedTo === "departure")) return null;
  const existing = Array.isArray(input.tickets) ? input.tickets : [];
  const combined = [...existing, ...candidates.map((scan) => ({ scan }))];
  if (returnTicketState({ ...base, tickets: combined }) !== "missing") return null;

  const leg = candidates[0];
  const from = stationText(leg.fromStation);
  const to = stationText(leg.toStation);
  const day = legDayLabel(leg.travelDate);
  const described = [from && to ? `${from} to ${to}` : null, day].filter(Boolean).join(", ");
  return {
    guidance: [
      from
        ? `Attach the ticket of the other way — the one you travelled on to ${from}. A second photo of the same ticket is not accepted.`
        : "Attach the ticket of the other way. A second photo of the same ticket is not accepted.",
    ],
    reason: `Not accepted: this is the same ticket already on this claim${described ? ` (${described})` : ""}. The claim pays a fare each way, so it needs the ticket for the other direction.`,
  };
}
