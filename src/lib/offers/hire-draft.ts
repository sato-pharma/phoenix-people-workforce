import { isIsoDate, parseLetterDate } from "@/lib/offers/dates";
import type { OfferRecord, OfferVacancyOption } from "@/lib/offers/types";

/**
 * What HR's "Add Employee" form can already know from an ACCEPTED offer letter.
 *
 * ── The gap this closes ──
 * An accepted offer had nowhere to go. Every fact on it — the name, the job title, the agreed
 * package, the first working day — was read off the Offers screen and retyped into a form standing
 * next to it, and then the right open seat was hunted by hand among 44 of them, 42 of which are
 * Medical Representative and tell each other apart only by line and area. This carries all of it
 * across in one click.
 *
 * ── What it deliberately does NOT do ──
 * It creates NOTHING. An employee record carries a salary breakdown, a bank account, insurance
 * numbers and a contract type that an offer letter has never known, and a half-configured employee
 * is one payroll then runs on. The real form still collects the rest and still writes the record.
 *
 * It DERIVES no money. `src/lib/payroll/policy.ts` owns every salary derivation in this system and
 * is owner-locked; `src/lib/offers/pay.ts` owns the letter's own split and documents at length why
 * the two must not be bound together. So the agreed monthly package is carried across exactly as it
 * was typed, as `grossSalary`, and basic, base and net are left for the form. A third opinion on
 * the money is the one thing this file must never become.
 *
 * It fills NO work email. The address on an offer is where the letter was sent — a personal one,
 * usually a Gmail. `employees.work_email` is a COMPANY address and is UNIQUE, and a new hire's
 * mailbox is opened by its own task after the record is written (`openAndAnnounceNewHireMailboxes`).
 * Writing the candidate's personal address into that column would look filled in and be wrong.
 *
 * It GUESSES no seat. The offer's `territory` is free text ("Qena", "Sohag 2") and its `reportsTo`
 * is a job title, not a person ("District Sales Manager") — measured on all 28 production offers on
 * 2026-09-29. Matching either against the open vacancies would silently pick one of three lines'
 * Medical Representative seats in the same area. So the seat is the one that was CHOSEN on the
 * offer, or nothing at all, and the form's own vacancy picker stays where a missing one is settled.
 */

export type OfferHireDraft = {
  areaId: string;
  departmentId: string;
  fullName: string;
  grossSalary: string;
  hireDate: string;
  jobTitle: string;
  lineId: string;
  managerHrId: string;
  positionId: string;
  regionName: string;
};

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A seat id off the wire, or null.
 *
 * Lives here — in the pure module — rather than in the route that first needed it, because a Next
 * route file may export only its HTTP methods and the config fields; a helper exported beside them
 * fails the build. Both `/api/offers` and `/api/offers/[id]` read the same value and must read it
 * the same way.
 *
 * Null is a real answer — "no seat chosen" — so anything unreadable collapses to it rather than
 * refusing the request: a letter must never fail to be written because a picker sent something odd.
 * A wrong id that survives this is refused by the foreign key, which is the right place for it.
 */
export function readOfferVacancyId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function id(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * The letter's start date, back in the form a date input speaks.
 *
 * An offer stores its dates the way the LETTER prints them — "01 October 2026" — so the value on
 * the row is not what `<input type="date">` accepts. `parseLetterDate` reads it back; the ISO
 * branch is for the free-text era before the composer had a picker, where a few rows carry ISO
 * already. Anything neither reads as blank rather than as a guessed date: a candidate turning up
 * on the wrong day is the failure this refuses to risk.
 */
export function offerHireDate(startDate: string | null | undefined): string {
  const raw = text(startDate);
  if (!raw) return "";
  if (isIsoDate(raw)) return raw;
  return parseLetterDate(raw) ?? "";
}

/**
 * Build the draft.
 *
 * `vacancy` is the seat the offer points at, re-read live and passed in only when it is STILL OPEN.
 * A seat that was filled while the offer was out must not be pre-selected here — the hire would
 * then be aimed at somebody else's chair, and the vacancy closer would find nothing to close. When
 * it is absent every seat field comes back empty, which is exactly the state the Add Employee form
 * already handles: its own picker is then how the seat is chosen.
 */
export function buildOfferHireDraft(input: {
  offer: Pick<OfferRecord, "candidateName" | "startDate" | "title" | "totalMonthly">;
  vacancy: OfferVacancyOption | null;
}): OfferHireDraft {
  const { offer, vacancy } = input;

  return {
    fullName: text(offer.candidateName),
    // The seat's own position title wins over the letter's when the two differ: the letter is
    // written in the words a candidate reads, the seat is what the organogram is keyed on.
    jobTitle: text(vacancy?.positionTitle) || text(vacancy?.jobTitle) || text(offer.title),
    hireDate: offerHireDate(offer.startDate),
    grossSalary:
      typeof offer.totalMonthly === "number" && Number.isFinite(offer.totalMonthly) && offer.totalMonthly > 0
        ? String(offer.totalMonthly)
        : "",

    // Where the seat sits. All of it from the vacancy row, none of it inferred from the letter.
    areaId: id(vacancy?.areaId),
    departmentId: id(vacancy?.departmentId),
    lineId: id(vacancy?.lineId),
    managerHrId: text(vacancy?.managerHrId),
    positionId: id(vacancy?.positionId),
    regionName: text(vacancy?.regionName),
  };
}
