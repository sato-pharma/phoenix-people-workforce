// ─────────────────────────────────────────────────────────────────────────────────────────────
// The joiners panel's decisions, as pure functions: who counts as arriving, what a save may hold,
// and how far along a person's papers are. Free of Supabase so the client component imports it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { hiringDocumentsFor } from "@/lib/hiring-documents/readiness-signal";
import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  UpdateHiringJoinerInput,
} from "@/lib/hiring-documents/types";
import { joiningDayKey } from "@/lib/hr/talent-acquisition-logic";
import { isUuid } from "@/lib/http/uuid";
import { isIsoDate } from "@/lib/offers/dates";

/** A note is a line or two about one phone call; this is the point it stops being one. */
export const HIRING_JOINER_NOTES_MAX = 1000;

/** A person's message about what they sent wrong, as opposed to the server failing. */
export class HiringJoinerInputError extends Error {}

export type JoinerOfferRow = {
  employeeHrId: string | null;
  id: string;
  name: string;
  startDate: string | null;
  status: string | null;
};

/**
 * The accepted offers whose joining day is today or later, nearest first. Same rule as the Talent
 * Acquisition page's joiners panel (`joiningDayKey`): an accepted offer only, and the employee
 * record's hire date beats the letter's once there is a record. `start_date` is free text on the
 * letter ("25 October 2026"), so a comparison in SQL cannot do this.
 *
 * A letter whose date cannot be read ("", "1/11/2026") with no record yet stays on the list, FIRST and
 * with an empty `startKey`: dropping it would hide a real joiner behind a list that looks complete.
 */
export function upcomingJoinerOffers<T extends JoinerOfferRow>(
  offers: readonly T[],
  input: { hireDateByHrId: ReadonlyMap<string, string>; todayKey: string },
): Array<{ offer: T; startKey: string }> {
  return offers
    .filter((offer) => offer.status === "accepted")
    .map((offer) => ({
      offer,
      startKey: joiningDayKey({ employeeHrId: offer.employeeHrId, startDate: offer.startDate ?? "" }, input.hireDateByHrId),
    }))
    .filter(({ offer, startKey }) => (startKey ? startKey >= input.todayKey : !offer.employeeHrId))
    .sort((left, right) => left.startKey.localeCompare(right.startKey) || left.offer.name.localeCompare(right.offer.name));
}

function optionalText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new HiringJoinerInputError(`${label} is required.`);
  const text = value.trim();
  return text || null;
}

/**
 * What a save may hold. EVERY FIELD MUST BE SENT, on purpose: the save replaces the row, so a field
 * left out by an older screen would otherwise wipe what was agreed. Null clears a field; a missing
 * one is refused.
 */
export function parseHiringJoinerUpdate(payload: unknown): UpdateHiringJoinerInput {
  const body = (payload ?? {}) as Record<string, unknown>;

  const offerId = typeof body.offerId === "string" ? body.offerId.trim() : "";
  if (!isUuid(offerId)) throw new HiringJoinerInputError("Choose a joiner.");

  if (typeof body.papersConfirmed !== "boolean") {
    throw new HiringJoinerInputError("Say whether the papers are confirmed.");
  }

  const attendanceDate = optionalText(body.attendanceDate, "Attendance date");
  if (attendanceDate && !isIsoDate(attendanceDate)) {
    throw new HiringJoinerInputError("Attendance date must be a real date.");
  }

  const attendanceTime = optionalText(body.attendanceTime, "Attendance time");
  if (attendanceTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(attendanceTime)) {
    throw new HiringJoinerInputError("Attendance time must be a time of day, like 09:30.");
  }

  const notes = optionalText(body.notes, "Note");
  if (notes && notes.length > HIRING_JOINER_NOTES_MAX) {
    throw new HiringJoinerInputError(`Keep the note under ${HIRING_JOINER_NOTES_MAX} characters.`);
  }

  return { attendanceDate, attendanceTime, notes, offerId, papersConfirmed: body.papersConfirmed };
}

export type JoinerPapersProgress = {
  /** The first paper still outstanding, which is where "Receive papers" opens. */
  firstOutstandingId: string | null;
  received: number;
  total: number;
};

/** How many of the papers this person owes are in. Exit documents do not count against a joiner. */
export function joinerPapersProgress(
  documents: HiringDocumentDefinition[],
  employee: HiringDocumentEmployeeRow,
): JoinerPapersProgress {
  const owed = hiringDocumentsFor(documents, employee);
  const outstanding = owed.filter((document) => employee.documents[document.id]?.status !== "submitted");
  return {
    firstOutstandingId: outstanding[0]?.id ?? null,
    received: owed.length - outstanding.length,
    total: owed.length,
  };
}
