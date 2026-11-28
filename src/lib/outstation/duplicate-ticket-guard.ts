/**
 * The same-ticket guard: one ticket, one parking cost and one receipt photo are claimed once.
 *
 * Owner-reported (October expense audit, 22 Nov 2026, "build the guards"). The same-trip guard
 * (duplicate-trip-guard.ts) refuses a copy only when person, day AND destination match, and three
 * real copies passed it because their destinations were worded differently:
 *  - OUTSTATION-318 and 320, Ali Mohamed Ali Elsayed, 28 Oct 2026: two Kafr El-Sheikh areas on one
 *    day, each claiming the same train tickets (130 + 220) and the same 200 other cost (parking).
 *  - OUTSTATION-401 and 402, Mohamed Ramadan, 18-19 and 19 Nov 2026: two New Cairo areas, each
 *    claiming the same 230 + 230 Cairo fare, filed an hour apart.
 *  - OUTSTATION-164 and 175, Nahed Tarek, 20-23 Sep 2026: "First Al Minya" and "Minya", the second
 *    carrying the first one's bus ticket photo again (IMG_1649.jpg, 361,687 bytes).
 *
 * So the money itself is compared, not the place. A claim repeats another live claim of the same
 * employee when:
 *  - TICKETS: the trips' dates overlap and both the go and the return ticket amounts are the same,
 *    with at least one of them above zero;
 *  - OTHER (parking): the trips' dates overlap, the other cost is the same and above zero, and the
 *    destination city is the same (or either side has none);
 *  - RECEIPT: a ticket photo of the same file name and the same size is already on the other
 *    claim, whatever its dates (the read that feeds this bounds them).
 *  - READ TICKET: a ticket the reader read (ticket-scan.ts) carries the same train or bus number and the
 *    same travel day as a read ticket already on the other claim — the same ticket photographed again
 *    is a new file, so the receipt print never sees it (owner, 2026-11-28, ZERO leniency: "مفيش فيها
 *    تهاون", after Weaam Gweed's Superjet 2244150 was photographed twice and her train 976 sent three
 *    times as legs of two claims). `sameTicketTwice` holds the same key inside one claim and one upload.
 *  - BOOKING: an online ticket's booking number (the reader reads it from the operator's PDF) is already on
 *    another claim of the same employee, whatever its day — a booking is claimed once (owner, 28 Nov 2026,
 *    District Manager expense rules). Inside one claim it is never refused: one booking can carry both legs.
 *
 * The same two halves as the same-trip guard, one rule:
 *  - SUBMISSION refuses the copy with words that name the earlier claim (service.ts), checked
 *    before any file is stored. Never a database constraint, never a stored claim auto-rejected.
 *  - The APPROVALS screen flags every pair already stored ("Same ticket as …"), a review signal
 *    only (the duplicate check in approvals/queue.ts). Stored pairs are decided by HR on Expense Approvals.
 *
 * Pure and synchronous: the read that feeds it lives in service.ts.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";

/** A claim's request id → how every screen names it. */
function outstationClaimRef(requestId: number | string) {
  return `OUTSTATION-${requestId}`;
}

/** A ticket photo as stored on a claim (`ticket_attachment_metadata`) or sent with a new one. */
export type TicketReceiptFile = {
  name?: string | null;
  size?: number | null;
};

/** One claim, as the guard compares it. */
export type DuplicateTicketCandidate = {
  employeeHrId: string;
  goTicketAmount?: number | null;
  otherAmount?: number | null;
  /** The ticket photos, as files or as fingerprints already made by `ticketReceiptFingerprint`. */
  receipts?: Array<TicketReceiptFile | string> | null;
  /** The tickets the reader read: stored metadata, scan records, or keys made by `readTicketKey`. */
  readTickets?: unknown;
  returnTicketAmount?: number | null;
  toCity?: string | null;
  tripEndDate?: string | null;
  tripStartDate: string;
};

export type DuplicateTicketExisting = DuplicateTicketCandidate & {
  id: number;
  status: string;
};

/** What the copy repeats, in the order an employee reads it. */
export type DuplicateTicketRepeat = "tickets" | "other" | "receipt" | "read_ticket" | "booking";

export type DuplicateTicketMatch = {
  earlier: DuplicateTicketExisting;
  repeats: DuplicateTicketRepeat[];
};

/**
 * Statuses that no longer claim anything — the same reading as duplicate-trip-guard.ts: a refused
 * claim never paid, so it must not block the employee from claiming the trip properly.
 */
const NON_CLAIMING_STATUSES = new Set(["rejected_by_system", "rejected_by_admin", "draft", "cancelled", "withdrawn"]);

function day(value: string | null | undefined) {
  return String(value ?? "").slice(0, 10);
}

function money(value: number | null | undefined) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function placeKey(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bgovernorate\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function hrKey(value: string | null | undefined) {
  return canonicalHrIdKey(value) ?? "";
}

/** [start, end] in YYYY-MM-DD; an end before the start, or none, is the start day. */
function span(claim: DuplicateTicketCandidate): [string, string] {
  const start = day(claim.tripStartDate);
  const end = day(claim.tripEndDate);
  return [start, end && end >= start ? end : start];
}

function datesOverlap(a: DuplicateTicketCandidate, b: DuplicateTicketCandidate) {
  const [startA, endA] = span(a);
  const [startB, endB] = span(b);
  if (!startA || !startB) return false;
  return startA <= endB && startB <= endA;
}

/**
 * A receipt's fingerprint: its file name (as the phone named it, case-folded) and its size in
 * bytes. Both are needed — "IMG_0001.jpg" alone repeats on every new phone. A file with no name or
 * no size has no fingerprint and matches nothing.
 */
export function ticketReceiptFingerprint(file: TicketReceiptFile): string | null {
  const name = String(file.name ?? "")
    .trim()
    .toLowerCase()
    // The stored name can carry the upload's "1-" order prefix (tickets/<hr>/<draft>/1-IMG_1649.jpg).
    .replace(/^\d+-/, "");
  const size = Number(file.size ?? 0);
  if (!name || !Number.isFinite(size) || size <= 0) return null;
  return `${name}|${Math.round(size)}`;
}

function fingerprints(files: Array<TicketReceiptFile | string> | null | undefined) {
  return new Set(
    (files ?? [])
      .map((file) => (typeof file === "string" ? file || null : ticketReceiptFingerprint(file)))
      .filter((value): value is string => Boolean(value)),
  );
}

/** A read ticket, as kept on a claim (`scan` of ticket_attachment_metadata) or just read for a new one. */
export type ReadTicket = {
  bookingNumber?: unknown;
  fromStation?: unknown;
  matchedTo?: unknown;
  toStation?: unknown;
  trainNumber?: unknown;
  travelDate?: unknown;
};

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

function asciiDigits(value: string): string {
  return value.replace(ARABIC_DIGITS, (digit) => String((digit.charCodeAt(0) & 0xf) % 10));
}

/**
 * A read ticket's identity: its travel day and its train or bus number (the reader puts a bus ticket's
 * serial there too — Superjet 2244150). One person cannot hold two tickets of the same number on the
 * same day as two different journeys. Null when the ticket was not read, or no number was read.
 */
export function readTicketKey(ticket: ReadTicket | null | undefined): string | null {
  if (!ticket || (ticket.matchedTo !== "arrival" && ticket.matchedTo !== "departure")) return null;
  const travel = String(ticket.travelDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(travel)) return null;
  const number = asciiDigits(String(ticket.trainNumber ?? ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/^0+(?=.)/, "");
  return number ? `${travel}|${number}` : null;
}

/** Every read ticket's key in a claim's stored metadata, a list of scan records, or a list of keys. */
export function readTicketKeys(tickets: unknown): string[] {
  if (!Array.isArray(tickets)) return [];
  return tickets
    .map((entry) => {
      if (typeof entry === "string") return entry || null;
      if (!entry || typeof entry !== "object") return null;
      const scan = "scan" in entry ? (entry as { scan?: unknown }).scan : entry;
      return scan && typeof scan === "object" ? readTicketKey(scan as ReadTicket) : null;
    })
    .filter((key): key is string => Boolean(key));
}

/**
 * An online ticket's booking number, made comparable: Western digits, lower case, letters and digits only.
 * Null under five characters — too short to be a booking code rather than a misread.
 */
export function readBookingKey(ticket: ReadTicket | null | undefined): string | null {
  if (!ticket) return null;
  const code = asciiDigits(String(ticket.bookingNumber ?? ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return code.length >= 5 ? code : null;
}

/** Every booking number in a claim's stored metadata or a list of scan records. */
export function readBookingKeys(tickets: unknown): string[] {
  if (!Array.isArray(tickets)) return [];
  return tickets
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const scan = "scan" in entry ? (entry as { scan?: unknown }).scan : entry;
      return scan && typeof scan === "object" ? readBookingKey(scan as ReadTicket) : null;
    })
    .filter((key): key is string => Boolean(key));
}

/** "train 976 on 19 Nov 2026" — a read ticket as the employee reads it. */
function readTicketWords(key: string): string {
  const [travel, number] = key.split("|");
  return `train or bus number ${number} on ${formatTripDay(travel ?? "")}`;
}

/**
 * The same read ticket twice inside ONE claim: picked twice in one upload, or picked again for a claim that
 * already carries it. Returns the refusal the employee reads, or null. Zero leniency (owner, 2026-11-28).
 */
export function sameTicketTwice(input: { candidates: ReadonlyArray<ReadTicket | null | undefined>; onThisClaim?: unknown }): { guidance: string[]; reason: string } | null {
  const held = new Set(readTicketKeys(input.onThisClaim));
  const picked = new Set<string>();
  for (const candidate of input.candidates) {
    const key = readTicketKey(candidate);
    if (!key) continue;
    if (held.has(key) || picked.has(key)) {
      const where = held.has(key) ? "already on this claim" : "chosen twice in this upload";
      return {
        guidance: ["Each ticket is attached once. Attach the ticket of the other journey, never a second photo of the same ticket."],
        reason: `Not accepted: this is the same ticket (${readTicketWords(key)}) ${where}.`,
      };
    }
    picked.add(key);
  }
  return null;
}

/** What `candidate` repeats of `other`, empty when nothing. */
export function ticketRepeats(candidate: DuplicateTicketCandidate, other: DuplicateTicketCandidate): DuplicateTicketRepeat[] {
  const repeats: DuplicateTicketRepeat[] = [];
  const overlap = datesOverlap(candidate, other);

  const goA = money(candidate.goTicketAmount);
  const returnA = money(candidate.returnTicketAmount);
  if (overlap && goA + returnA > 0 && goA === money(other.goTicketAmount) && returnA === money(other.returnTicketAmount)) {
    repeats.push("tickets");
  }

  const otherA = money(candidate.otherAmount);
  const cityA = placeKey(candidate.toCity);
  const cityB = placeKey(other.toCity);
  if (overlap && otherA > 0 && otherA === money(other.otherAmount) && (!cityA || !cityB || cityA === cityB)) {
    repeats.push("other");
  }

  const mine = fingerprints(candidate.receipts);
  if (mine.size > 0) {
    for (const print of fingerprints(other.receipts)) {
      if (mine.has(print)) {
        repeats.push("receipt");
        break;
      }
    }
  }

  // Whatever the dates and the amounts: the ticket's own day and number are the identity.
  const read = new Set(readTicketKeys(candidate.readTickets));
  if (read.size > 0 && readTicketKeys(other.readTickets).some((key) => read.has(key))) repeats.push("read_ticket");

  // An online booking is claimed once, on whichever day (owner, 28 Nov 2026).
  const bookings = new Set(readBookingKeys(candidate.readTickets));
  if (bookings.size > 0 && readBookingKeys(other.readTickets).some((key) => bookings.has(key))) repeats.push("booking");
  return repeats;
}

/**
 * The earliest live claim of the same employee whose ticket, other cost or receipt this one
 * repeats, or null. `excludeRequestId` is the request being re-submitted itself.
 */
export function findDuplicateTicket(
  candidate: DuplicateTicketCandidate,
  existing: DuplicateTicketExisting[],
  excludeRequestId?: number,
): DuplicateTicketMatch | null {
  const hrId = hrKey(candidate.employeeHrId);
  if (!hrId || !day(candidate.tripStartDate)) return null;

  const matches = existing
    .filter((row) => row.id !== excludeRequestId)
    .filter((row) => !NON_CLAIMING_STATUSES.has(row.status))
    .filter((row) => hrKey(row.employeeHrId) === hrId)
    .map((row) => ({ earlier: row, repeats: ticketRepeats(candidate, row) }))
    .filter((match) => match.repeats.length > 0)
    .sort((a, b) => a.earlier.id - b.earlier.id);
  return matches[0] ?? null;
}

function formatTripDay(iso: string) {
  const date = new Date(`${day(iso)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day(iso);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" });
}

function repeatWords(repeats: DuplicateTicketRepeat[]) {
  const words = repeats.map((repeat) =>
    repeat === "tickets"
      ? "the same go and return tickets"
      : repeat === "other"
        ? "the same other cost (such as parking)"
        : repeat === "read_ticket"
          ? "the same ticket (the same train or bus number on the same day)"
          : repeat === "booking"
            ? "the same online booking (the same booking number)"
            : "the same ticket photo",
  );
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The words an employee reads when the copy is refused. */
export function duplicateTicketMessage(match: DuplicateTicketMatch) {
  const ref = outstationClaimRef(match.earlier.id);
  return (
    `This claim repeats ${repeatWords(match.repeats)} already claimed on ${ref} — ${formatTripDay(match.earlier.tripStartDate)}. ` +
    "A ticket, a parking cost and a receipt are claimed once, so this claim was not submitted. " +
    `If this is a different journey, remove the repeated amount or photo and submit again; if something on ${ref} is wrong, ask HR to correct or reject it.`
  );
}

/** One row of the approvals screen, as the pair flag reads it. */
export type DuplicateTicketRow = {
  date: string;
  goTicketAmount?: number | null;
  hrId?: string | null;
  otherAmount?: number | null;
  receipts?: Array<TicketReceiptFile | string> | null;
  readTickets?: unknown;
  returnTicketAmount?: number | null;
  status?: string | null;
  toCity?: string | null;
  toDate?: string | null;
  tripId: string;
};

/**
 * Pairs on the approvals screen: every live row whose ticket, other cost or receipt repeats another
 * live row of the same employee, mapped to the OTHER rows' trip ids. A rejected row is no copy. A
 * flag is a review signal, never a decision: nothing is refused or held by it.
 */
export function flagDuplicateTicketRows(rows: DuplicateTicketRow[]): Map<string, string[]> {
  const groups = new Map<string, DuplicateTicketRow[]>();
  for (const row of rows) {
    const hrId = hrKey(row.hrId);
    if (!hrId || !day(row.date) || !row.tripId) continue;
    if (/reject|declin/i.test(String(row.status ?? ""))) continue;
    groups.set(hrId, [...(groups.get(hrId) ?? []), row]);
  }

  const asClaim = (row: DuplicateTicketRow): DuplicateTicketCandidate => ({
    employeeHrId: String(row.hrId ?? ""),
    goTicketAmount: row.goTicketAmount,
    otherAmount: row.otherAmount,
    readTickets: row.readTickets,
    receipts: row.receipts,
    returnTicketAmount: row.returnTicketAmount,
    toCity: row.toCity,
    tripEndDate: row.toDate,
    tripStartDate: row.date,
  });

  const flags = new Map<string, string[]>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      const copies = group
        .filter((other) => other.tripId !== row.tripId && ticketRepeats(asClaim(row), asClaim(other)).length > 0)
        .map((other) => other.tripId);
      if (copies.length > 0) flags.set(row.tripId, copies);
    }
  }
  return flags;
}
