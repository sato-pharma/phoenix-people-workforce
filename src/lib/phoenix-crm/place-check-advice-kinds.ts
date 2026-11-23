/**
 * The system's recommendation on Place checks — its kinds, their labels and codes, and the evidence each
 * adviser reads. Moved out of `place-check-advice.ts` unchanged on 23 Nov 2026, so no file of Place checks
 * is over 400 lines; that file re-exports everything here, so import from it.
 */

import type { ScheduleHeldBecause, ScheduleLegibility, ScheduleProblem } from "@/lib/phoenix-crm/schedule-rules";
import type { ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";

export type PlaceCheckAdviceKind = "approve" | "reject" | "look";

export type PlaceCheckAdvice = {
  kind: PlaceCheckAdviceKind;
  /** Why, in one or two plain sentences. */
  reason: string;
  /** What was read, verbatim and in its own script, quoted under the reason. */
  quote: string | null;
  /** The refusal reason a Reject opens on — set only where he rejected almost every time. */
  refusal: ValidationRefusalReason | null;
  /** The kind of advice, stable whatever the sentence says: what the decision keeps and the meter counts. */
  code: string;
  /** He agreed with this kind at least 19 times in 20, so the page may call it ready or sure. */
  confident: boolean;
};

/** The word on the badge. */
export const PLACE_CHECK_ADVICE_LABEL: Record<PlaceCheckAdviceKind, string> = {
  approve: "Approve",
  reject: "Reject",
  look: "Check it yourself",
};

/**
 * What was read on a sign — the same shape the clinic rows, the held rows and the buildings carry.
 * `problem` is what the reader said stops the name being read (2026-10-18); absent on older reads.
 */
export type SignEvidence = {
  verdict: string;
  reason: string | null;
  signText: string | null;
  problem?: string | null;
  /** The rep has been asked for a new photo of this sign and has not sent it yet. */
  retake?: boolean;
} | null;

/** What was read on a timetable for one customer. */
export type TimetableEvidence = {
  verdict: "match" | "other_name" | "no_schedule" | "unjudged";
  scheduleText: string | null;
  hoursRead: string | null;
  reason?: string | null;
  legibility?: ScheduleLegibility | null;
  problem?: ScheduleProblem | null;
  heldBecause?: ScheduleHeldBecause | null;
  /** The photo was uploaded from the phone on the last try, not taken live. */
  uploaded?: boolean;
} | null;

/**
 * Every kind of advice, named for the 30-day meter ("how often you agreed, kind by kind"). A code is
 * never shown; this is what stands for it. Worded for a sign that must name a customer OR a building.
 */
const ADVICE_KIND_LABEL = {
  sign_match: "Sign matches the name",
  sign_other_name: "Sign shows another name",
  sign_no_plate: "No sign in the photo",
  sign_no_name: "Sign without the name",
  sign_unread: "Sign never read",
  sign_retake: "New photo asked for",
  sign_unclear: "Sign legible, name not confirmed",
  sign_stylised: "Decorative lettering",
  sign_building_only: "Only the building's sign",
  sign_unreadable: "Sign could not be read",
  sign_read_again: "Sign read again tonight",
  sign_other_script: "Sign in another script",
  sign_readings_disagree: "Two readings disagreed",
  sign_name_unusable: "Name cannot be compared",
  sign_no_answer: "Sign reading did not come back",
  timetable_exempt: "Building has no timetable",
  timetable_unread: "Timetable not read yet",
  timetable_match: "Timetable names the customer",
  timetable_other_name: "Name not found on the timetable",
  timetable_on_screen: "Timetable on a screen",
  timetable_not_found: "No timetable found, no reason kept",
  timetable_missing: "Not a timetable",
  timetable_part_read: "Part of the timetable read",
  timetable_unreadable: "Timetable could not be read",
  timetable_held_elsewhere: "Held for another reason",
  timetable_no_answer: "Timetable reading did not come back",
} as const;

type AdviceKindCode = keyof typeof ADVICE_KIND_LABEL;

/** The base kinds, for the test that walks every one of them. */
export const PLACE_CHECK_ADVICE_KIND_CODES = Object.keys(ADVICE_KIND_LABEL) as AdviceKindCode[];

export const GOOGLE_PREFIX = "google_";
export const BUILDING_PREFIX = "building_";

/**
 * A kind of advice in words. A place Google held and a building are the same kinds counted apart, so
 * they are the same words with who it was about in front. A code this file does not know (an older
 * build's, kept on a decision) reads "Another kind", never the code itself.
 */
export function placeCheckAdviceKindLabel(code: string | null): string {
  if (!code) return "Not recorded";
  const [lead, base] = code.startsWith(GOOGLE_PREFIX)
    ? ["Google held · ", code.slice(GOOGLE_PREFIX.length)]
    : code.startsWith(BUILDING_PREFIX)
      ? ["Building · ", code.slice(BUILDING_PREFIX.length)]
      : ["", code];
  const label = (ADVICE_KIND_LABEL as Record<string, string>)[base];
  return label ? `${lead}${label}` : "Another kind";
}

export function approve(code: AdviceKindCode, reason: string, quote: string | null, confident: boolean): PlaceCheckAdvice {
  return { kind: "approve", reason, quote, refusal: null, code, confident };
}

export function reject(code: AdviceKindCode, reason: string, quote: string | null, refusal: ValidationRefusalReason | null, confident = false): PlaceCheckAdvice {
  return { kind: "reject", reason, quote, refusal, code, confident };
}

export function look(code: AdviceKindCode, reason: string, quote: string | null = null): PlaceCheckAdvice {
  return { kind: "look", reason, quote, refusal: null, code, confident: false };
}

export const NO_ANSWER = "The reading did not come back, so the system has no answer. Look at the photo yourself.";

/** What is wrong with a timetable photograph, as a clause: "it was taken too far away". */
export const PROBLEM_CLAUSE: Record<ScheduleProblem, string> = {
  not_a_timetable: "it is not a timetable",
  on_a_screen: "it was photographed off a phone or computer screen",
  too_far: "it was taken too far away",
  blurred: "the photo is blurred",
  glare: "a reflection covers it",
  cut_off: "part of it is cut off",
};
