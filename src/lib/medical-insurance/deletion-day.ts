// ─────────────────────────────────────────────────────────────────────────────────────────────
// The day a deletion goes to Libano-Suisse with, and how far back it may go (owner, 27 Nov 2026: "It must follow
// what I say … audit the contract and know how far back we can backdate, and always go back as far as you can").
// Pure, and free of Supabase and the file system, so the Add / Remove screen and the server read the same rule.
//
// WHAT THE PAPERS SAY:
//   * THE SIGNED POLICY 50048950, clause 5/5/4 ("الحذف"), is the highest of them: a deletion takes effect from the day
//     Libano-Suisse RECEIVES the deletion form and the membership cards, and the cards are returned before the deletion
//     date. No card back, no refund at all; a late card cuts the refund by the delay, and Sato alone pays what the
//     deleted person runs up until the card is back. Its annex (page 34) refunds the rest of the term one month after the
//     deletion date, claims or none. So the contract gives NO right to backdate: an earlier date is a request the
//     insurer may honour, never a claim on it.
//   * Libano-Suisse's own Additions and Deletions workbook checks every deletion date with
//     `IF((TODAY()-date)<Assumptions!E7,"Checked","Exceed Grace period")`, E7 being "Gras Period for addition or
//     deletion". Our file writes E7 = LIBANO_GRACE_PERIOD_DAYS (the rules page's 15 days), so a date passes when it
//     is at most 14 days behind the day the file is sent. The blank template as Libano-Suisse issued it holds 31.
//   * The same workbook's rules page says a deletion is accepted on the day of the request or after it. It
//     contradicts the sheet's own check above; the check is what runs on our file.
//   * The signed renewal offer (page 6) refunds by the day from the deletion date to the policy's end, and sets
//     no limit on how far back the deletion date may be.
//   * Nobody is deleted before their own cover began, nor after the policy ends.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { addDays } from "./cost";

/** The grace period our file writes into Libano-Suisse's sheet (Assumptions!E7), and the one its check reads. */
export const LIBANO_GRACE_PERIOD_DAYS = 15;
/** The sheet's check is "fewer than the grace period", so a date may sit at most one day less behind the sending day. */
export const LIBANO_MOST_DAYS_BACK = LIBANO_GRACE_PERIOD_DAYS - 1;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(DAY_PATTERN);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

function later(a: string, b: string): string {
  return a > b ? a : b;
}

/** The earliest deletion date Libano-Suisse's sheet accepts on the sending day, and never before cover began. */
export function earliestDeletionDay(input: { coverStart: string; sendingDay: string }): string {
  return later(addDays(input.sendingDay, -LIBANO_MOST_DAYS_BACK), input.coverStart);
}

/**
 * The deletion date a removal starts with: as far back as Libano-Suisse accepts, for everyone due now (the owner's
 * word, so the refund is the largest the contract allows). Someone leaving later keeps their own exit day, and a
 * spouse or child left open under an ended employee keeps that employee's end, never earlier.
 */
export function defaultDeletionDay(
  action: { timing: "now" | "soon"; effectiveOn: string; memberType: "employee" | "spouse" | "child" },
  input: { coverStart: string; sendingDay: string },
): string {
  const earliest = earliestDeletionDay(input);
  if (action.timing === "soon") return later(action.effectiveOn, earliest);
  if (action.memberType !== "employee") return later(action.effectiveOn, earliest);
  return earliest;
}

/** Why a typed deletion date cannot go on the file, in words naming the person; null when it can. */
export function deletionDayProblem(
  day: unknown,
  input: { coverStart: string; sendingDay: string; policyEndsOn: string; name: string; formatDay: (day: string) => string },
): string | null {
  const { coverStart, formatDay, name, policyEndsOn, sendingDay } = input;
  if (!isRealDay(day)) return `Give a deletion date for ${name}.`;
  if (day < coverStart) return `${name}'s deletion date cannot be before their cover began, on ${formatDay(coverStart)}.`;
  const earliest = earliestDeletionDay({ coverStart, sendingDay });
  if (day < earliest) {
    return `${name}'s deletion date, ${formatDay(day)}, is more than ${LIBANO_MOST_DAYS_BACK} days before today. Libano-Suisse's sheet accepts a deletion at most ${LIBANO_MOST_DAYS_BACK} days back (its ${LIBANO_GRACE_PERIOD_DAYS}-day grace period); the earliest is ${formatDay(earliest)}.`;
  }
  if (day > policyEndsOn) return `${name}'s deletion date cannot be after the policy ends, on ${formatDay(policyEndsOn)}.`;
  return null;
}
