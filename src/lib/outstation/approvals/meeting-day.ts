/**
 * Meetings are held on a Thursday — the one rule (owner, 2026-11-23: "I want you to flag any meeting
 * that is not on Thursday").
 *
 * 🔴 ON THE DESK, A FLAG, NEVER A REFUSAL. A stored claimed meeting on any other day fails this check, so
 *    the claim is filed in "Your call" with the day in words and is never Ready. Nothing here rejects a
 *    stored claim or changes its amount: the approver's press decides (checks.ts).
 * 🔴 AT SUBMIT, A REFUSAL (owner, 28 Nov 2026: "the weekly meetings are only accepted on Thursday. No any
 *    other meeting will be accepted not on Thursday", for everyone): `meetingDayRefusal` is the same verdict,
 *    and service.ts refuses a new claim it fails before anything is stored. "Could not check" is let through.
 *
 * What counts as a claimed meeting:
 *   - a claim filed as Meeting, and
 *   - a Traveling or Other claim that carries a meeting amount.
 * On 23 Nov 2026 production held one waiting Meeting claim, on a Thursday, and five waiting Traveling
 * or Other claims with a meeting amount, none of them on a Thursday.
 *
 * A claim of several days does not say which day the meeting was held, so it passes when one of its
 * days is a Thursday and fails when none is. A claim with no readable day is "could not check",
 * which is never a pass.
 *
 * The weekday is read from the date's own text, so no timezone can move it. Pure and import-free.
 */

import type { CheckAnswer, ClaimKind } from "@/lib/outstation/approvals/types";

/** `Date.getUTCDay()` of the meeting day: Thursday. */
export const MEETING_WEEKDAY = 4;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso: string | null | undefined): { day: number; month: number; weekday: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // "2026-02-31" rolls over to March: a day that does not exist has no weekday.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { day, month, weekday: date.getUTCDay() };
}

/** 0 = Sunday … 6 = Saturday; null when the text is not a real day. */
export function weekdayOf(iso: string | null | undefined): number | null {
  return parts(iso)?.weekday ?? null;
}

export function isMeetingDay(iso: string | null | undefined): boolean {
  return weekdayOf(iso) === MEETING_WEEKDAY;
}

/** "Monday 2 Nov". */
function dayWords(iso: string): string {
  const read = parts(iso);
  return read ? `${WEEKDAYS[read.weekday]} ${read.day} ${MONTHS[read.month - 1]}` : "an unknown day";
}

/** "2 Nov". */
function shortDayWords(iso: string): string {
  const read = parts(iso);
  return read ? `${read.day} ${MONTHS[read.month - 1]}` : "an unknown day";
}

const egp = (amount: number) => `EGP ${Math.round(amount * 100) / 100}`;

export type MeetingDayVerdict = { answer: CheckAnswer; sentence: string };

/**
 * The Thursday check for one claim, or null when the claim claims no meeting. `dates` are the
 * claim's own days, first to last; `meetingCost` is the meeting amount the claim would be paid.
 */
export function meetingDayVerdict(input: { dates: ReadonlyArray<string>; kind: ClaimKind; meetingCost: number }): MeetingDayVerdict | null {
  const filedAsMeeting = input.kind === "meeting";
  const cost = Number.isFinite(input.meetingCost) && input.meetingCost > 0 ? input.meetingCost : 0;
  if (!filedAsMeeting && cost === 0) return null;

  const dates = input.dates.filter((date) => weekdayOf(date) !== null);
  if (dates.length === 0) {
    return { answer: "unknown", sentence: `${filedAsMeeting ? "The meeting" : `The meeting cost of ${egp(cost)}`} carries no day, so its weekday is not checked.` };
  }
  const thursday = dates.find(isMeetingDay);

  if (dates.length === 1) {
    if (thursday) {
      return { answer: "pass", sentence: filedAsMeeting ? `The meeting was on ${dayWords(thursday)}.` : `The meeting cost of ${egp(cost)} was claimed on ${dayWords(thursday)}.` };
    }
    return {
      answer: "fail",
      sentence: filedAsMeeting
        ? `The meeting was on ${dayWords(dates[0])}, not a Thursday.`
        : `A meeting cost of ${egp(cost)} was claimed on ${dayWords(dates[0])}, not a Thursday.`,
    };
  }

  const span = `${shortDayWords(dates[0])} to ${shortDayWords(dates[dates.length - 1])}`;
  if (thursday) {
    return {
      answer: "pass",
      sentence: filedAsMeeting ? `The meeting claim covers ${dayWords(thursday)}.` : `The meeting cost of ${egp(cost)} was claimed for days that include ${dayWords(thursday)}.`,
    };
  }
  return {
    answer: "fail",
    sentence: filedAsMeeting
      ? `The meeting claim covers ${span}, with no Thursday among its ${dates.length} days.`
      : `A meeting cost of ${egp(cost)} was claimed for ${span}, with no Thursday among the ${dates.length} days.`,
  };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A claim's own days, first to last (at most 62), from its start and end dates. */
export function claimDays(startDate: string | null | undefined, endDate: string | null | undefined): string[] {
  const start = parts(startDate);
  if (!start) return [];
  const first = Date.parse(`${String(startDate).slice(0, 10)}T00:00:00Z`);
  const last = parts(endDate) ? Date.parse(`${String(endDate).slice(0, 10)}T00:00:00Z`) : first;
  const days: string[] = [];
  for (let at = first; at <= Math.max(first, last) && days.length < 62; at += 24 * 60 * 60 * 1000) days.push(isoDay(at));
  return days;
}

/**
 * The refusal a new claim reads when it claims a meeting with no Thursday among its days (owner, 28 Nov
 * 2026), or null. The words contain "must be", so every submit route answers it 400.
 */
export function meetingDayRefusal(input: {
  endDate: string | null | undefined;
  kind: ClaimKind;
  meetingCost: number;
  startDate: string | null | undefined;
}): string | null {
  const verdict = meetingDayVerdict({ dates: claimDays(input.startDate, input.endDate), kind: input.kind, meetingCost: input.meetingCost });
  if (!verdict || verdict.answer !== "fail") return null;
  return `${verdict.sentence} A weekly meeting must be on a Thursday: a meeting on any other day is not accepted. Change the date to the Thursday it was held, or remove the meeting.`;
}
