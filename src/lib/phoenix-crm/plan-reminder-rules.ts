/**
 * Phoenix CRM — the "your coming week is not sent" reminder, composed.
 *
 * Owner, 2026-10-02. The new weekly plan went live at 01:55 Cairo that Friday. By 11:20 none of the 13
 * Delta (1) reps had sent their week of 3 October, and it was due that night. He chose the reminder,
 * and he chose WHO gets it: **the teams that started** — every rep under a district manager whose
 * team has begun using Phoenix CRM. This is the 06:55 digest's rule, applied to the plan: a team
 * still on iReports360 is never told about a screen it has not opened.
 *
 * ## When
 *
 * From the day the week is due until the day before it starts: `weeklyPlanDueOn` (the Thursday before,
 * or a date he moved by hand) through the Friday. On the due day it says "due tonight". On a later
 * day it says the week is late but still accepted. Both are true: a late week is stamped, never
 * refused. Any other day there is nothing to say, and the job sends nothing.
 *
 * ## To whom
 *
 * - **The rep**, about his own week. It is his work, so it is his to see (Golden rule #1 draws the
 *   line at what judges his honesty, never at his own plan).
 * - **His district manager**, once, naming every rep of his whose week is not sent.
 *
 * Twice a day, once a tick (owner, 2026-10-02: "Yes, remind again"). The 12:57 tick tells everyone
 * whose week is not sent; the 17:57 tick tells whoever is STILL not sent, in its own words. The keys are
 * per person, per week, per Cairo day, per tick, so a retry or a double fire of one tick reaches nobody
 * twice, and a rep who sent between the two ticks hears nothing more.
 *
 * ## Never email
 *
 * In-app, Telegram and phone push. `enforcePhoenixCrmEmailBlock` strips email from every Phoenix CRM
 * event outside the plan-edit chain, whatever a caller asks for.
 */

import { CAIRO_MONTHS } from "@/lib/format/cairo-datetime";
import { addDaysIso } from "@/lib/crm/dates";
import { PLAN_DEADLINE_LABEL, repPlanWeek, weekdayOfIsoDay, weeklyPlanDueOn } from "@/lib/phoenix-crm/calendar";
import { territoryReviewer, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { PHOENIX_CRM_WEEKDAY_NAMES } from "@/lib/phoenix-crm/timings";

export const PLAN_REMINDER_JOB_SLUG = "phoenix-crm-plan-reminder";

/** 12:57 and 17:57 Cairo. Two ticks a day so a deploy or a cut tick still leaves one. The keys stop a double send. */
export const PLAN_REMINDER_CRON = "57 12,17 * * *";

/** Which of the day's two ticks this is: the 12:57 one, or the 17:57 one that says "still". */
export type PlanReminderTick = "noon" | "evening";

/** The tick a run belongs to, from the Cairo hour it runs at. Anything from 15:00 on is the evening one. */
export function reminderTickOf(cairoHour: number): PlanReminderTick {
  return cairoHour < 15 ? "noon" : "evening";
}

/** The most names one manager's message lists; beyond it, it counts the rest. */
export const PLAN_REMINDER_MAX_NAMES = 12;

export type PlanReminderDay = {
  /** The week the reps are planning: the one starting the coming Saturday. */
  weekStart: string;
  dueOn: string;
  /** Past the due day: still accepted, stamped late. */
  late: boolean;
};

/** "Saturday 3 Oct" */
export function reminderDayLabel(isoDay: string): string {
  const [, month, day] = isoDay.split("-").map(Number);
  return `${PHOENIX_CRM_WEEKDAY_NAMES[weekdayOfIsoDay(isoDay)]} ${day} ${CAIRO_MONTHS[month - 1] ?? ""}`;
}

/** Whether today is a reminder day, and for which week. Null on every other day. */
export function planReminderDay(cairoToday: string): PlanReminderDay | null {
  const weekStart = repPlanWeek(cairoToday);
  const dueOn = weeklyPlanDueOn(weekStart);
  if (cairoToday < dueOn || cairoToday >= weekStart) return null;
  return { weekStart, dueOn, late: cairoToday > dueOn };
}

/** A plan status that means the week has NOT gone for review: no plan, a draft, or one sent back. */
export function isUnsentStatus(status: string | null | undefined): boolean {
  return status !== "submitted" && status !== "approved";
}

export type PlanReminderNotice = {
  hrId: string;
  title: string;
  message: string;
  idempotencyKey: string;
};

export function repReminder(input: {
  hrId: string;
  day: PlanReminderDay;
  cairoToday: string;
  tick: PlanReminderTick;
  draftStarted: boolean;
}): PlanReminderNotice {
  const week = reminderDayLabel(input.day.weekStart);
  // 🔴 THE DEADLINE LEADS THE TITLE (owner, 2026-10-02: "show the deadline in the rep's plan reminder on
  // the phone"). This notice goes out on `push` as well as in-app and Telegram, and a phone shows the
  // HEADING and cuts it — OneSignal's `headings`, a lock screen, one line. Put the deadline at the end,
  // the way it reads on a desk, and it is the first thing truncation takes; put it first and he reads it
  // without opening anything. The week still follows it, named, never a date code.
  const when = input.day.late ? `Was due ${reminderDayLabel(input.day.dueOn)}, ${PLAN_DEADLINE_LABEL}` : `Due tonight, ${PLAN_DEADLINE_LABEL}`;
  const title = `${when} — your week of ${week}`;
  const how = input.draftStarted ? "Open Plan, check your days and press Send." : "Open Plan, tick your customers day by day and press Send.";
  // The body no longer opens with "It", which pointed at a title that said "is not sent yet" — the title
  // now leads with the deadline, so the sentence has to carry its own subject.
  // At 17:57 the same sentence says "still" (owner, 2026-10-02: "Yes, remind again").
  const notSent = input.tick === "evening" ? "Your plan is still not sent." : "Your plan is not sent yet.";
  const what = input.day.late ? `${notSent} Send it before ${week}. A late week is still accepted.` : notSent;
  return {
    hrId: input.hrId,
    title,
    message: `${what} ${how}`,
    idempotencyKey: `phoenix_crm:plan_reminder:rep:${input.hrId}:${input.day.weekStart}:${input.cairoToday}:${input.tick}`,
  };
}

export function managerReminder(input: {
  hrId: string;
  day: PlanReminderDay;
  cairoToday: string;
  tick: PlanReminderTick;
  repNames: ReadonlyArray<string>;
}): PlanReminderNotice | null {
  const names = [...input.repNames].sort((left, right) => left.localeCompare(right));
  if (names.length === 0) return null;
  const week = reminderDayLabel(input.day.weekStart);
  const shown = names.slice(0, PLAN_REMINDER_MAX_NAMES);
  const more = names.length - shown.length;
  // At 17:57 his count says "still" too (owner, 2026-10-02: "Yes, remind again").
  const still = input.tick === "evening" ? " still" : "";
  const count = names.length === 1 ? `1 of your reps${still} has` : `${names.length} of your reps${still} have`;
  // The deadline leads his title as well (owner, 2026-10-02), for the same reason it leads the rep's:
  // this notice goes out on `push`, and a phone shows the heading and cuts it. He is the one who can
  // still chase a rep before 23:55, so the hour is the part he must not have to open the app to read.
  const when = input.day.late ? `Was due ${reminderDayLabel(input.day.dueOn)}, ${PLAN_DEADLINE_LABEL}` : `Due tonight, ${PLAN_DEADLINE_LABEL}`;
  return {
    hrId: input.hrId,
    title: `${when} — ${count} not sent the week of ${week}`,
    // The names carry the body on their own now the deadline has moved into the title; it used to open
    // with "It", which pointed at a title that no longer says what "it" is.
    message: `Not sent yet: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`,
    // The tick is part of the key, so the 12:57 and 17:57 notices are two, not one repeated.
    idempotencyKey: `phoenix_crm:plan_reminder:dm:${input.hrId}:${input.day.weekStart}:${input.cairoToday}:${input.tick}`,
  };
}

/** The last day a week can still be sent before it starts — the Friday. Exported for the tests' calendar walk. */
export function lastReminderDay(weekStart: string): string {
  return addDaysIso(weekStart, -1);
}

/** The team a territory belongs to: its district manager, or the vacant seat above it when nobody sits there. */
export function teamKeyOf(org: OrgIndex, seat: OrgSeat): string {
  return territoryReviewer(org, seat.seatId)?.hrId ?? `vacant:${seat.parentSeatId ?? seat.seatId}`;
}

/**
 * The territories of every team in which at least one territory has started (owner, 2026-10-02:
 * "teams that started"). A rep whose own first entries were wiped is still reminded when his team
 * has started.
 */
export function territoriesOfStartedTeams(org: OrgIndex, seats: ReadonlyArray<OrgSeat>, started: ReadonlySet<string>): OrgSeat[] {
  const startedTeams = new Set(seats.filter((seat) => started.has(seat.seatId)).map((seat) => teamKeyOf(org, seat)));
  return seats.filter((seat) => startedTeams.has(teamKeyOf(org, seat)));
}
