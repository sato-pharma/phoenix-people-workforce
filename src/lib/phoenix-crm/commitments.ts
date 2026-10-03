/**
 * Phoenix CRM — what the rep PROMISED, and has not come back to yet. No I/O.
 *
 * At every visit he records a next step (`VISIT_NEXT_STEPS`, visit-outcome.ts) with an optional day he
 * means to do it on. Until now only ONE of the six ever came back to him: `follow_up`, and only as a
 * suggestion while he plans next week (`followUpInWeek`, plan-insight.ts). "Send the data", "Arrange a
 * double visit", "Invite to an event" and "Chase the pharmacy stock" had no home at all — he typed
 * them at the door and they vanished when the visit closed. This is their home.
 *
 * ## Golden rule #1 — this is the BLIND side of the boundary, read the right way round
 *
 * The boundary the owner drew on 2026-09-26 is WHOSE WORK IT IS: his plan, his day, his targets and an
 * approval he asked for are his and stay visible; anything that judges his honesty is never his. A
 * commitment is a sentence HE wrote about work HE chose to do, so showing it back to him is the EASY
 * half of the rule, not a breach of the blind half: there is no count of how many he kept, no rate, no
 * score, no streak, no "overdue" verdict about HIM — only the four things he said and when he said he
 * would do them. Nothing here is readable above him either; it is not a report, it is his own note.
 *
 * So: no aggregate figure of any kind on this view, and no judging word anywhere in the wording below.
 * "Overdue" is said of the DAY HE CHOSE, never of the rep. Adding a kept/missed figure would turn his
 * own notebook into the one thing the rule forbids.
 *
 * ## Open and closed are DERIVED, and nothing new is stored
 *
 * A commitment is ADDRESSED the moment a LATER visit to the same customer exists — "it comes back to
 * him at the NEXT visit to the same customer" is already how the module works (visit-outcome.ts), and
 * the newest visit's answer is the one that stands: a later "Nothing to follow" closes an older
 * promise, and a repeated one re-opens it on the new day. That rule is `pickLastNextStep`, and this
 * file CALLS it rather than restating it — there is no second definition of "still open" anywhere.
 *
 * 🔴 SO THERE IS NO DISMISS AND NO "DONE" TICK, DELIBERATELY. A completion input would be a new step in
 * the rep's day, and adding ANY step needs the owner's word first (golden rule #1, the EASY half). He
 * already closes a commitment the only way that costs him nothing: by going back.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { fieldWeekStart, isIsoDay } from "@/lib/phoenix-crm/calendar";
import {
  pickLastNextStep,
  type LastNextStep,
  type LastNextStepRow,
  type VisitNextStep,
} from "@/lib/phoenix-crm/visit-outcome";

/**
 * How recently he must have made an UNDATED promise for it still to be listed: THIRTY DAYS.
 *
 * A dated commitment says for itself whether it is still live. An undated one never stops being
 * technically open, so without a window the list would grow for ever and end up being the one thing it
 * must not be — a backlog he is measured against. Thirty days is about two visit cycles on an A
 * customer, so a promise he has not been back for inside that window is still a promise; past it, the
 * next visit is what carries it, exactly as the visit form already does ("what he said last time").
 *
 * An undated promise dropped by this window is COUNTED and said in a sentence, never silently gone
 * (`staleUndated` below).
 */
export const UNDATED_COMMITMENT_WINDOW_DAYS = 30;

/** One earlier visit, as the server reads it back — `LastNextStepRow` plus the name to print. */
export type CommitmentVisitRow = LastNextStepRow & {
  /** The customer's name. Names, never ids — the owner's standing rule. */
  customerName: string;
};

export type CommitmentGroupKey = "overdue" | "today" | "week" | "undated";

/** The four groups, in the order they are read. */
export const COMMITMENT_GROUP_ORDER: readonly CommitmentGroupKey[] = ["overdue", "today", "week", "undated"];

/**
 * What each group is CALLED.
 *
 * "Overdue" is about the day he picked, and the group under it says so in full. There is no wording
 * here that could be read as a verdict on the rep: no "missed", no "failed", no "you did not".
 */
const COMMITMENT_GROUP_TITLES: Record<CommitmentGroupKey, string> = {
  overdue: "The day you set has passed",
  today: "You set today",
  week: "Later this week",
  undated: "No day set",
};

export function commitmentGroupTitle(key: CommitmentGroupKey): string {
  return COMMITMENT_GROUP_TITLES[key];
}

export type RepCommitment = {
  customerId: string;
  customerName: string;
  nextStep: VisitNextStep;
  /** `visitNextStepLabel` — the same words the chip carried at the door. */
  label: string;
  /** The day he said it: the visit's own Cairo day. */
  promisedOn: string;
  /** The day he said he would do it, when he set one. */
  dueOn: string | null;
  group: CommitmentGroupKey;
};

export type CommitmentGroup = { key: CommitmentGroupKey; title: string; commitments: RepCommitment[] };

export type RepCommitments = {
  groups: CommitmentGroup[];
  /**
   * Open commitments he dated AFTER this field week. Not listed — they are not due, and a list of
   * everything he has ever promised is a backlog — but said as a sentence, because silently dropping
   * one of his own notes is the one thing worse than listing it.
   */
  datedLater: number;
  /** Undated promises older than `UNDATED_COMMITMENT_WINDOW_DAYS`. Said the same way, for the same reason. */
  staleUndated: number;
};

/**
 * The last day of the field week this list looks into: the Thursday of the field week holding `today`.
 *
 * 🔴 AND ON A FRIDAY IT LOOKS INTO THE WEEK THAT STARTS THE NEXT MORNING. A Friday belongs to the week
 * BEFORE it (calendar.ts `fieldWeekStart`), so that week's Thursday is already behind him — "Later this
 * week" would be empty on a Friday and everything he had dated for the coming Saturday would read as
 * "dated later". A rep opening the app on a Friday is looking at the week about to start.
 */
export function commitmentWeekEnd(today: string): string {
  const thursday = addDaysIso(fieldWeekStart(today), 5);
  return thursday >= today ? thursday : addDaysIso(fieldWeekStart(today), 12);
}

/** Which group a still-open commitment belongs in, or null when it is not listed at all. */
function groupOf(due: string | null, promisedOn: string, today: string, weekEnd: string): CommitmentGroupKey | null {
  if (due === null) {
    return promisedOn >= addDaysIso(today, -UNDATED_COMMITMENT_WINDOW_DAYS) ? "undated" : null;
  }
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due <= weekEnd ? "week" : null;
}

/** Inside a group: the day he set first, then the day he said it, then the name. A total order. */
function compareCommitments(left: RepCommitment, right: RepCommitment): number {
  const byDue = (left.dueOn ?? "").localeCompare(right.dueOn ?? "");
  if (byDue !== 0) return byDue;
  const byPromise = left.promisedOn.localeCompare(right.promisedOn);
  if (byPromise !== 0) return byPromise;
  return left.customerName.localeCompare(right.customerName);
}

/**
 * His open commitments, grouped.
 *
 * `visits` is every visit of his own seat inside the read's window, in any order and with any number
 * per customer: `pickLastNextStep` reduces it to at most ONE still-open promise per customer — the
 * newest visit's answer — which IS the "addressed at the next visit" rule. A name that is not in
 * `visits` cannot appear, so there is no path to an id on screen.
 *
 * An EMPTY group is dropped rather than drawn empty: a heading with nothing under it reads as a hole.
 */
export function buildRepCommitments(input: { visits: readonly CommitmentVisitRow[]; today: string }): RepCommitments {
  const { today } = input;
  const weekEnd = commitmentWeekEnd(today);
  const names = new Map<string, string>();
  for (const visit of input.visits) if (visit.customerName) names.set(visit.customerId, visit.customerName);

  const open: ReadonlyMap<string, LastNextStep> = pickLastNextStep(input.visits);
  const byGroup = new Map<CommitmentGroupKey, RepCommitment[]>();
  let datedLater = 0;
  let staleUndated = 0;

  for (const [customerId, step] of open) {
    const customerName = names.get(customerId);
    // No name, no row. A visit whose customer the read could not name is not turned into an id.
    if (!customerName) continue;
    const dueOn = isIsoDay(step.dueOn) ? step.dueOn : null;
    const group = groupOf(dueOn, step.date, today, weekEnd);
    if (group === null) {
      if (dueOn === null) staleUndated += 1;
      else datedLater += 1;
      continue;
    }
    const bucket = byGroup.get(group) ?? [];
    bucket.push({
      customerId,
      customerName,
      nextStep: step.nextStep,
      label: step.label,
      promisedOn: step.date,
      dueOn,
      group,
    });
    byGroup.set(group, bucket);
  }

  const groups: CommitmentGroup[] = [];
  for (const key of COMMITMENT_GROUP_ORDER) {
    const commitments = byGroup.get(key);
    if (!commitments || commitments.length === 0) continue;
    groups.push({ key, title: commitmentGroupTitle(key), commitments: commitments.sort(compareCommitments) });
  }
  return { groups, datedLater, staleUndated };
}

/** The sentence under an empty list. It says what the list IS, never how he did. */
export const COMMITMENTS_EMPTY_NOTE = "Nothing you said you would do is still waiting. What you write at a visit shows up here.";

/**
 * The one line naming what is open but not listed — the ones dated past this week, and the undated
 * ones he made more than a month ago. Null when everything open is on screen.
 */
export function commitmentsNotListedNote(input: Pick<RepCommitments, "datedLater" | "staleUndated">): string | null {
  const parts: string[] = [];
  if (input.datedLater > 0) {
    parts.push(`${input.datedLater} ${input.datedLater === 1 ? "is dated" : "are dated"} after this week`);
  }
  if (input.staleUndated > 0) {
    parts.push(`${input.staleUndated} with no day ${input.staleUndated === 1 ? "was" : "were"} written more than a month ago`);
  }
  if (parts.length === 0) return null;
  return `Also open: ${parts.join(", and ")}. They come back at your next visit to the customer.`;
}
