// ─────────────────────────────────────────────────────────────────────────────────────────────
// The joiners panel's decisions, as pure functions: who counts as arriving, what a save may hold,
// and how far along a person's papers are. Free of Supabase so the client component imports it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { hiringDocumentsFor } from "@/lib/hiring-documents/readiness-signal";
import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringJoiner,
  HiringJoinerDayOne,
  UpdateHiringJoinerInput,
} from "@/lib/hiring-documents/types";
import { daysBetweenKeys, joiningDayKey } from "@/lib/hr/talent-acquisition-logic";
import { isUuid } from "@/lib/http/uuid";
import { isIsoDate } from "@/lib/offers/dates";

/** A joiner who starts within this many days with something still to agree is called first. */
export const HIRING_JOINER_SOON_DAYS = 3;

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

export type JoinerStanding = {
  kind: "confirmed" | "partial" | "open";
  /** What is still to agree with them. */
  missing: Array<"papers" | "day" | "time">;
};

/** Where one joiner stands: all three agreed, some of them, or none. A note alone agrees nothing. */
export function joinerStanding(
  joiner: Pick<HiringJoiner, "attendanceDate" | "attendanceTime" | "papersConfirmed">,
): JoinerStanding {
  const missing: JoinerStanding["missing"] = [];
  if (!joiner.papersConfirmed) missing.push("papers");
  if (!joiner.attendanceDate) missing.push("day");
  if (!joiner.attendanceTime) missing.push("time");
  if (missing.length === 0) return { kind: "confirmed", missing };
  return { kind: missing.length === 3 ? "open" : "partial", missing };
}

/** True when they start within HIRING_JOINER_SOON_DAYS and something is still to agree. */
export function joinerIsUrgent(
  joiner: Pick<HiringJoiner, "attendanceDate" | "attendanceTime" | "papersConfirmed" | "startKey">,
  todayKey: string,
): boolean {
  if (!joiner.startKey || joinerStanding(joiner).kind === "confirmed") return false;
  return daysBetweenKeys(todayKey, joiner.startKey) <= HIRING_JOINER_SOON_DAYS;
}

/** The three reads behind Day one, each keyed by `canonicalHrIdKey`. Null means that read failed. */
export type JoinerDayOneReads = {
  deviceCounts: ReadonlyMap<string, number> | null;
  logins: ReadonlySet<string> | null;
  mailboxes: ReadonlyMap<string, string | null> | null;
};

/** One person's answers from the three reads. A read that failed stays null, never a "no". */
export function joinerDayOneFacts(key: string, reads: JoinerDayOneReads): HiringJoinerDayOne {
  let mailbox: HiringJoinerDayOne["mailbox"] = null;
  if (reads.mailboxes) {
    const status = reads.mailboxes.get(key);
    if (status === undefined) mailbox = "none";
    else mailbox = status === "connected" || status === "not_needed" ? status : "pending";
  }
  return {
    devicesOutstanding: reads.deviceCounts ? (reads.deviceCounts.get(key) ?? 0) : null,
    hasActiveLogin: reads.logins ? reads.logins.has(key) : null,
    mailbox,
  };
}

export type JoinerDayOneItem = {
  key: "account" | "device" | "mailbox" | "record";
  label: string;
  /** late is a thing not done with the joining day inside HIRING_JOINER_SOON_DAYS. */
  state: "done" | "late" | "neutral" | "open" | "unread";
  value: string;
};

/**
 * What stands ready for a joiner's first day. It reports: the person reading it may not be able to do
 * these, and the HR Operations Specialist activates no account. Everything but the record hangs off
 * the record, so without one the other three say so rather than reading as undone.
 */
export function joinerDayOneItems(
  joiner: Pick<HiringJoiner, "dayOne" | "employeeHrId" | "startKey">,
  todayKey: string,
): JoinerDayOneItem[] {
  const notDone =
    joiner.startKey && daysBetweenKeys(todayKey, joiner.startKey) <= HIRING_JOINER_SOON_DAYS ? "late" : "open";

  if (!joiner.employeeHrId) {
    return [
      { key: "record", label: "Record", state: notDone, value: "Not created yet" },
      { key: "account", label: "Account", state: "neutral", value: "After the record" },
      { key: "mailbox", label: "Mailbox", state: "neutral", value: "After the record" },
      { key: "device", label: "Device", state: "neutral", value: "After the record" },
    ];
  }

  const { devicesOutstanding, hasActiveLogin, mailbox } = joiner.dayOne;
  const unread = { state: "unread", value: "Not read" } as const;
  const mailboxAnswer = {
    connected: { state: "done", value: "Connected" },
    none: { state: notDone, value: "Not opened" },
    not_needed: { state: "neutral", value: "Not needed" },
    pending: { state: notDone, value: "Pending" },
  } as const;

  return [
    { key: "record", label: "Record", state: "done", value: "Created" },
    {
      key: "account",
      label: "Account",
      ...(hasActiveLogin === null
        ? unread
        : hasActiveLogin
          ? ({ state: "done", value: "Active" } as const)
          : ({ state: notDone, value: "Not active yet" } as const)),
    },
    { key: "mailbox", label: "Mailbox", ...(mailbox === null ? unread : mailboxAnswer[mailbox]) },
    {
      key: "device",
      label: "Device",
      ...(devicesOutstanding === null
        ? unread
        : devicesOutstanding > 0
          ? ({ state: "done", value: `${devicesOutstanding} issued` } as const)
          : ({ state: "neutral", value: "None issued" } as const)),
    },
  ];
}

/** The counts above the list. A joiner with no readable date is still someone to confirm. */
export function joinersSummary(
  joiners: ReadonlyArray<Pick<HiringJoiner, "attendanceDate" | "attendanceTime" | "mobile" | "papersConfirmed">>,
): { arriving: number; noMobile: number; toConfirm: number } {
  return {
    arriving: joiners.length,
    noMobile: joiners.filter((joiner) => !joiner.mobile).length,
    toConfirm: joiners.filter((joiner) => joinerStanding(joiner).kind !== "confirmed").length,
  };
}
