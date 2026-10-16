/**
 * Phoenix CRM — the rep's request for a double visit, with no I/O.
 *
 * Owner, 2026-10-16: "the last question while rep logging a visit to an am or pm account must be: do
 * you need a double visit with this dr/account? If yes show him manager and rsm if applicable and nsm
 * and pm and gpm if applicable, and then make him able to choose up to 3 timings, make him then able to
 * edit the timing but never cancel his request. After that a new sidebar report is generated for
 * managers which pumps notifications when they receive this request, and all managers must have access
 * on this report as per their scope up to the CEO."
 *
 * His answers to the three questions put to him the same day:
 *
 *   - WHO      any number of the people offered may be ticked; each is asked, told and answers on his own;
 *   - WHEN     a timing is a DAY only — up to three field days, no clock time;
 *   - ANSWER   a person asked accepts ONE of the days, or declines; the rep reads "Accepted, <day>" or
 *              "Declined" and may edit the days, never cancel.
 *
 * This is NOT the older visit ask (visit-ask-rules.ts), which asks ONE person and which the rep can take
 * back. That feature is untouched; the day arithmetic and the offered people are shared with it.
 *
 * Golden Rule #1: the question is the LAST thing on the form, defaults to No, and a rep who answers No
 * is asked nothing more.
 */

import type { CompanyOffer } from "@/lib/phoenix-crm/visit-company";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { personKey } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { isVisitAskFieldDay, visitAskDayChoices, visitAskLastDay } from "@/lib/phoenix-crm/visit-ask-rules";

// ── The words ───────────────────────────────────────────────────────────────────────────────────

/** How many days the rep may offer: "up to 3 timings". */
export const DOUBLE_VISIT_MAX_DAYS = 3;

/** Each person answers on his own: waiting → accepted (with one of the days) or declined. */
export type DoubleVisitPersonStatus = "waiting" | "accepted" | "declined";

export function isDoubleVisitPersonStatus(value: unknown): value is DoubleVisitPersonStatus {
  return value === "waiting" || value === "accepted" || value === "declined";
}

export type DoubleVisitRole = "manager" | "product_manager";

export function isDoubleVisitRole(value: unknown): value is DoubleVisitRole {
  return value === "manager" || value === "product_manager";
}

/**
 * The question exists for AM and PM accounts only (owner: "a visit to an am or pm account"). A
 * pharmacy is neither, and is never asked about.
 */
export function isDoubleVisitRequestable(listType: PhoenixCrmListType | string | null | undefined): boolean {
  return listType === "AM" || listType === "PM";
}

/**
 * The same question asked of a customer the form already holds. The visit form is held to carry no list
 * type of its own (`tests/phoenix-crm-visit-form-ease.test.ts`: logging is one tap and the server stamps
 * the rest), so it asks this instead of reading the field.
 */
export function isDoubleVisitCustomer(customer: { listType: PhoenixCrmListType | string | null | undefined }): boolean {
  return isDoubleVisitRequestable(customer.listType);
}

/** What the last question says to the rep, and what its two answers are. */
export const DOUBLE_VISIT_QUESTION = "Do you need a double visit with this customer?";

// ── The days ────────────────────────────────────────────────────────────────────────────────────

/**
 * The days the rep may offer: today and every field day of the next four weeks, never a Friday and
 * never a confirmed public holiday — the same list the older ask offers.
 */
export function doubleVisitDayChoices(cairoToday: string, holidays: ReadonlyMap<string, string>): string[] {
  return visitAskDayChoices(cairoToday, holidays);
}

export type DoubleVisitDaysResult = { ok: true; days: string[] } | { ok: false; error: string };

export const CHOOSE_A_DAY = "Choose at least one day for the double visit.";
export const TOO_MANY_DAYS = `Choose up to ${DOUBLE_VISIT_MAX_DAYS} days.`;
export const DAY_NOT_OFFERED = "Choose days from the list offered. Reload the page.";

/**
 * The days a request names, checked before the database is asked: one to three, each a field day from
 * today to four weeks on, none twice, none a public holiday. Returned earliest first. The database holds
 * the same bounds again (`phoenix_crm_raise_double_visit_request`); only the holiday calendar is the
 * application's alone, because it lives outside the module's tables.
 */
export function resolveDoubleVisitDays(input: {
  days: unknown;
  cairoToday: string;
  holidays: ReadonlyMap<string, string>;
}): DoubleVisitDaysResult {
  if (!Array.isArray(input.days)) return { ok: false, error: CHOOSE_A_DAY };
  const seen = new Set<string>();
  for (const entry of input.days) {
    if (typeof entry !== "string") return { ok: false, error: DAY_NOT_OFFERED };
    const day = entry.trim();
    if (!isIsoDay(day)) return { ok: false, error: DAY_NOT_OFFERED };
    seen.add(day);
  }
  if (seen.size === 0) return { ok: false, error: CHOOSE_A_DAY };
  // A day named twice is one day the rep tapped twice, not a fourth: more than three DISTINCT days is the refusal.
  if (seen.size > DOUBLE_VISIT_MAX_DAYS) return { ok: false, error: TOO_MANY_DAYS };
  const last = visitAskLastDay(input.cairoToday);
  for (const day of seen) {
    if (!isVisitAskFieldDay(day) || day < input.cairoToday || day > last || input.holidays.has(day)) {
      return { ok: false, error: DAY_NOT_OFFERED };
    }
  }
  return { ok: true, days: [...seen].sort() };
}

/** The days after one is ticked or un-ticked: at most three, in the order picked; a fourth changes nothing. */
export function toggleDoubleVisitDay(picked: ReadonlyArray<string>, day: string): string[] {
  if (picked.includes(day)) return picked.filter((entry) => entry !== day);
  return picked.length >= DOUBLE_VISIT_MAX_DAYS ? [...picked] : [...picked, day];
}

// ── The people ──────────────────────────────────────────────────────────────────────────────────

export type DoubleVisitPerson = { hrId: string; role: DoubleVisitRole };

export type DoubleVisitPeopleResult = { ok: true; people: DoubleVisitPerson[] } | { ok: false; error: string };

export const CHOOSE_A_PERSON = "Choose at least one person to ask for the double visit.";
export const PERSON_NOT_OFFERED = "Choose people from the list offered. Reload the page.";

/**
 * The people the rep ticked, checked against the list HE WAS OFFERED (his territory's managers and his
 * line's product managers): at least one, each of them offered, none twice. The role is read from the
 * offer — never from the phone — and the hr id is the offer's own spelling.
 */
export function resolveDoubleVisitPeople(input: {
  picked: unknown;
  offers: ReadonlyArray<CompanyOffer>;
}): DoubleVisitPeopleResult {
  if (!Array.isArray(input.picked)) return { ok: false, error: CHOOSE_A_PERSON };
  const people: DoubleVisitPerson[] = [];
  const seen = new Set<string>();
  for (const entry of input.picked) {
    const key = personKey(typeof entry === "string" ? entry : null);
    if (!key) return { ok: false, error: PERSON_NOT_OFFERED };
    if (seen.has(key)) continue;
    const offer = input.offers.find((candidate) => personKey(candidate.hrId) === key);
    if (!offer) return { ok: false, error: PERSON_NOT_OFFERED };
    seen.add(key);
    people.push({ hrId: offer.hrId, role: offer.role });
  }
  if (people.length === 0) return { ok: false, error: CHOOSE_A_PERSON };
  return { ok: true, people };
}

/** The picks after one person is ticked or un-ticked — any number, in the order picked. */
export function toggleDoubleVisitPerson(picked: ReadonlyArray<string>, hrId: string): string[] {
  const key = personKey(hrId);
  if (!key) return [...picked];
  return picked.some((entry) => personKey(entry) === key) ? picked.filter((entry) => personKey(entry) !== key) : [...picked, hrId];
}

// ── What the visit's body carries ───────────────────────────────────────────────────────────────

/** The last question as the form sends it: No (nothing else is read), or Yes with the people and days. */
export type DoubleVisitAnswer = { wanted: false } | { wanted: true; hrIds: unknown; days: unknown };

/** Read the body's `doubleVisit` strictly: only a literal `wanted: true` asks for anything. */
export function parseDoubleVisitAnswer(value: unknown): DoubleVisitAnswer {
  if (!value || typeof value !== "object") return { wanted: false };
  const body = value as Record<string, unknown>;
  if (body.wanted !== true) return { wanted: false };
  return { wanted: true, hrIds: body.hrIds, days: body.days };
}

// ── How it reads ────────────────────────────────────────────────────────────────────────────────

/**
 * How the rep reads one person's answer — the owner's words: "Waiting for Dina Hamdy", "Accepted, Tue 6
 * Oct", "Declined". `visitOnText` is the screen's own day label for the day picked.
 */
export function doubleVisitPersonStatusText(input: {
  status: DoubleVisitPersonStatus;
  name: string;
  visitOnText: string | null;
}): string {
  if (input.status === "waiting") return `Waiting for ${input.name}`;
  if (input.status === "accepted") return input.visitOnText ? `${input.name}: accepted, ${input.visitOnText}` : `${input.name}: accepted`;
  return `${input.name}: declined`;
}

/** How many of a request's people are in each state — the report's one-line head count. */
export function doubleVisitTally(people: ReadonlyArray<{ status: DoubleVisitPersonStatus }>): {
  waiting: number;
  accepted: number;
  declined: number;
} {
  let waiting = 0;
  let accepted = 0;
  let declined = 0;
  for (const person of people) {
    if (person.status === "waiting") waiting += 1;
    else if (person.status === "accepted") accepted += 1;
    else declined += 1;
  }
  return { waiting, accepted, declined };
}

/** The saved visit's banner about the request it raised: who is asked, or that it was already asked. */
export function doubleVisitSavedNote(input: { created: boolean; names: ReadonlyArray<string> } | null): string | null {
  if (!input || input.names.length === 0) return null;
  const who = input.names.length === 1 ? input.names[0] : `${input.names.slice(0, -1).join(", ")} and ${input.names[input.names.length - 1]}`;
  return input.created
    ? `${who} ${input.names.length === 1 ? "is" : "are"} asked for a double visit with you. The answers show on the customer's page.`
    : `A double visit to this customer is already asked of ${who}. The answers show on the customer's page.`;
}
