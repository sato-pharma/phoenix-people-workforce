/**
 * Meetings are held on a Thursday — the one rule (owner, 2026-11-23: "I want you to flag any meeting
 * that is not on Thursday").
 *
 * 🔴 A FLAG, NEVER A REFUSAL. A claimed meeting on any other day fails this check, so the claim is
 *    filed in "Your call" with the day in words and is never Ready. Nothing here rejects it, changes
 *    its amount or stops it being filed: the approver's press decides (checks.ts).
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
