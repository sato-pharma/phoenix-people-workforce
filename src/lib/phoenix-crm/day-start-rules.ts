/**
 * Phoenix CRM — "I started working" (owner, 2026-10-03).
 *
 * WHY IT EXISTS, in his words: *"as u know the visit is entered after it is done so i want to know
 * when actually did they start working"*. A visit's `captured_at` is the end of a call, never the
 * start of a morning, so nothing in the module could answer when a rep actually began. This is the
 * one press that answers it.
 *
 * 🔴 IT IS SHOWN ONLY BEFORE HIS FIRST AM VISIT, AND ONLY TODAY. *"Only before the first AM visit
 * show them an obvious clean button … press here before doing only the first AM visit and confirm
 * before not after."* Once an AM visit is saved the button is gone for the day — pressing it
 * afterwards would record the time he remembered, which is the figure this feature exists to avoid.
 *
 * 🔴 AND IT IS NOT ONE OF THE MODULE'S SILENT CHECKS. He ruled the same day: *"when they press the
 * button their location and their time send to managers and saved in system"* — so the reading goes
 * to his district manager and the SFE Manager, and the button SAYS SO before he presses it. That is
 * the line Golden Rule #1 actually draws: the blind half forbids a check he cannot see, not a report
 * he makes himself. Nothing here may ever become silent.
 *
 * 🔴 IT NEVER BLOCKS A VISIT (his choice, asked directly). A rep who forgets and logs his first AM
 * visit simply loses the button; his visit saves exactly as it always did, and his manager's screen
 * shows no start time for that day. The rep's app does not stop him at a customer's door.
 */

import { BROWSER_PLACEHOLDER } from "@/lib/phoenix-crm/browser-name";

/** The button, in the owner's own words. */
export const DAY_START_BUTTON_LABEL = "Show your manager you started working";

/** Under the button, also his: before the first AM visit, and before it rather than after. */
export const DAY_START_BUTTON_NOTE = "Press here before your first AM visit — before it, not after.";

/**
 * The third line, which his ruling REQUIRES: the press sends where he is. He is told before he
 * presses, never after, because a rep learning afterwards that his position travelled is exactly the
 * "caught" feeling the module's first rule exists to prevent.
 */
export const DAY_START_LOCATION_NOTE = "Your district manager and the SFE Manager see the time and where you are.";

/** What he reads once it is done. The time is the SERVER's, which is the only one anybody is judged by. */
export function dayStartDoneTitle(clock: string): string {
  return `Your manager has been told · ${clock}`;
}

export const DAY_START_DONE_NOTE = "You started your day at this time. Log your visits as normal.";

/** The server's sentence when the phone will not give a position — his own work failing, nothing else. */
export const NO_FIX_FOR_A_DAY_START =
  `Your location is switched off, so this cannot be sent. Switch location on for ${BROWSER_PLACEHOLDER} and press it again.`;

export type DayStartView = {
  /** The server's stamp, ISO. */
  startedAt: string;
  /** The minute his sent plan said he would start the morning, when he had one. */
  plannedAmMinute: number | null;
};

/**
 * Whether the rep may still press it: his own territory, today, no AM visit saved yet, and not
 * already pressed. One rule, read by the day view and by the save, so the screen can never offer a
 * press the server would refuse.
 */
export function canStartDay(input: {
  /** The viewer is the territory's own rep (never a manager entering for him). */
  viewerIsRep: boolean;
  /** The day on screen is today's visit day. */
  isToday: boolean;
  /** AM visits already saved today. */
  amVisits: number;
  /** He has already pressed it today. */
  alreadyStarted: boolean;
}): boolean {
  return input.viewerIsRep && input.isToday && input.amVisits === 0 && !input.alreadyStarted;
}

/** "08:42" from a minute of the day, for the planned-start comparison a manager reads. */
export function minuteClock(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** What the managers' own screens call it (owner, 2026-10-03: "show the day start time on the team day screen"). */
export const DAY_START_READ_LABEL = "Started working";

/**
 * The line a MANAGER reads — on the day in full, and on the Team tab: when the rep said he started,
 * beside what his own sent plan had said about the morning.
 *
 * 🔴 THERE IS NO SENTENCE FOR A DAY WITH NO START, and that is the rule rather than an omission. The
 * press never blocks a visit and was never required (`day-start-rules` above), so "not confirmed"
 * would read as an accusation on every day a rep simply logged his first visit first — and on every
 * day that passed before this feature existed. A day with no start shows no line at all, which is
 * exactly what the feature's own rule says his manager sees.
 *
 * The clock is passed in rather than formatted here: the SERVER owns the timezone, the same shape
 * `teamTodayLine` already uses for the last visit.
 */
export function dayStartReadLine(dayStart: DayStartView, clock: string): string {
  return dayStart.plannedAmMinute === null
    ? `${clock} · they had no sent plan for this day`
    : `${clock} · their plan said ${minuteClock(dayStart.plannedAmMinute)}`;
}
