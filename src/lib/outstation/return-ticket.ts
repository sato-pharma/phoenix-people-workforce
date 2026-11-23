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

type StoredScan = {
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
