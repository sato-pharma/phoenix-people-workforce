// Recruitment — reminders to the person chosen to conduct an interview (owner, 2026-09-20).
//
// "The interviewer that I choose ... his interviews appears to him and send him reminders" — by all
// three channels (in-app, email, Telegram), on two clocks: the EVENING BEFORE at 5:00 PM Cairo with
// that day's whole list, and ONE HOUR BEFORE each interview.
//
// NO LEDGER TABLE. Every message carries an idempotency key and `createSystemNotification` delivers a
// key once, so a job that runs every ten minutes — or twice at once — tells nobody twice. The key of a
// one-hour reminder holds the interview's start time, so an interview that is MOVED is reminded about
// again at its new time; the evening list's key holds a fingerprint of what is on it, so a list that
// changed after 5 PM (something added, moved, cancelled) is sent once more, and an unchanged one never.
//
// WHO GETS ONE: only a chosen interviewer who is a District Manager or above and whose interview has no
// outcome yet. A cancelled interview is a deleted row, so it is never here to be reminded about.
//
// THE PLAN IS PURE (`planInterviewReminders`), so the timing is tested without a database or a clock.

import { createHash } from "node:crypto";

import { createSystemNotification } from "@/lib/notifications/system";
import { listInterviewsToRemindAbout, type ReminderInterview } from "@/lib/recruitment/interview-calendar";
import { interviewCalendarHref, isDistrictManagerOrAbove } from "@/lib/recruitment/interview-calendar-types";
import {
  addDays,
  cairoDateKey,
  cairoMinutesOfDay,
  formatDayLong,
  formatTimeOfDay,
  isBookableDay,
  weekStartFor,
} from "@/lib/recruitment/interview-calendar-week";

/** 5:00 PM Cairo — from here on, the next working day's list goes out. */
export const EVENING_REMINDER_MINUTES = 17 * 60;
/** One hour ahead of the interview. */
export const HOUR_REMINDER_LEAD_MINUTES = 60;
const PORTAL_BASE = "/employee-portals/interview-calendar";
const SEARCH_AHEAD_DAYS = 4;
/**
 * How many days AFTER an interview to keep nagging the interviewer to record what happened (owner,
 * 2026-09-23: "keeps pumping ... the first thing that stops it is that the interviewer responds").
 * Recording any outcome removes the interview from the reminder source, so the pump stops at once; this
 * bound only keeps a truly-abandoned interview from nagging forever.
 */
export const AWAITING_PUMP_MAX_DAYS = 30;
/** Not before this hour (Cairo) does the daily "record what happened" nag go out. */
export const AWAITING_PUMP_MINUTES = 9 * 60;

export type InterviewReminder = {
  kind: "evening" | "hour" | "awaiting";
  /** The message's idempotency key — the whole "sent already?" memory. */
  key: string;
  recipientHrId: string;
  title: string;
  message: string;
  subject: string;
  href: string;
  metrics: Array<{ label: string; value: string }>;
};

function where(interview: ReminderInterview): string {
  return interview.platform === "zoom" ? "Zoom" : "In office";
}

function clockOf(interview: ReminderInterview): string {
  return formatTimeOfDay(cairoMinutesOfDay(new Date(interview.startsAt)));
}

function linkTo(interview: ReminderInterview): string {
  return interviewCalendarHref({
    base: PORTAL_BASE,
    open: interview.id,
    weekStart: weekStartFor(cairoDateKey(new Date(interview.startsAt))),
  });
}

/** The next working day after `today` (Sunday to Thursday) — Thursday evening looks to Sunday. */
export function nextWorkingDayAfter(today: string): string | null {
  for (let step = 1; step <= SEARCH_AHEAD_DAYS; step += 1) {
    const day = addDays(today, step);
    if (isBookableDay(day)) return day;
  }
  return null;
}

function fingerprint(list: readonly ReminderInterview[]): string {
  const text = list
    .map((interview) => `${interview.id}@${interview.startsAt}`)
    .sort()
    .join("|");
  return createHash("sha1").update(text).digest("hex").slice(0, 10);
}

/** Everything that should be sent at `now`. Nothing is sent, read or written here. */
export function planInterviewReminders(interviews: readonly ReminderInterview[], now: Date): InterviewReminder[] {
  const reminders: InterviewReminder[] = [];
  const eligible = interviews.filter((interview) => isDistrictManagerOrAbove({ jobTitle: interview.interviewerJobTitle }));
  const nowMs = now.getTime();

  // One hour before, for each interview on its own.
  for (const interview of eligible) {
    const minutesAway = (new Date(interview.startsAt).getTime() - nowMs) / 60_000;
    if (minutesAway <= 0 || minutesAway > HOUR_REMINDER_LEAD_MINUTES) continue;
    const time = clockOf(interview);
    reminders.push({
      href: linkTo(interview),
      key: `interview-reminder-hour:${interview.id}:${interview.startsAt}`,
      kind: "hour",
      message: `Interview with ${interview.candidateName} at ${time} (${where(interview)}) — starting within the hour.`,
      metrics: [
        { label: "Candidate", value: interview.candidateName },
        { label: "Time", value: time },
        { label: "Where", value: where(interview) },
      ],
      recipientHrId: interview.interviewerHrId,
      subject: `Interview at ${time} — ${interview.candidateName}`,
      title: `Interview in about an hour — ${time}`,
    });
  }

  // AFTER the interview, once a day from 9:00 AM Cairo, until the interviewer records what happened.
  // The source query only ever returns interviews with no outcome, so recording one stops this at
  // once; the day-stamped key makes it fire once per day and again the next day while it stays open.
  if (cairoMinutesOfDay(now) >= AWAITING_PUMP_MINUTES) {
    const todayKey = cairoDateKey(now);
    for (const interview of eligible) {
      const startMs = new Date(interview.startsAt).getTime();
      const endMs = startMs + interview.durationMinutes * 60_000;
      if (endMs > nowMs) continue; // still ahead, or in progress — wait until it has actually ended
      const daysSince = (nowMs - startMs) / 86_400_000;
      if (daysSince > AWAITING_PUMP_MAX_DAYS) continue;
      const heldDay = formatDayLong(cairoDateKey(new Date(interview.startsAt)));
      reminders.push({
        href: linkTo(interview),
        key: `interview-reminder-awaiting:${interview.id}:${todayKey}`,
        kind: "awaiting",
        message: `Your interview with ${interview.candidateName} (${heldDay}) is waiting for your response — record what happened on the interview calendar.`,
        metrics: [
          { label: "Candidate", value: interview.candidateName },
          { label: "Interview", value: heldDay },
        ],
        recipientHrId: interview.interviewerHrId,
        subject: `Record what happened — ${interview.candidateName}`,
        title: `Awaiting your response — ${interview.candidateName}`,
      });
    }
  }

  // The evening before, from 5:00 PM Cairo, one list per interviewer for the next working day.
  if (cairoMinutesOfDay(now) >= EVENING_REMINDER_MINUTES) {
    const day = nextWorkingDayAfter(cairoDateKey(now));
    if (day) {
      const byPerson = new Map<string, ReminderInterview[]>();
      for (const interview of eligible) {
        if (cairoDateKey(new Date(interview.startsAt)) !== day) continue;
        const list = byPerson.get(interview.interviewerHrId) ?? [];
        list.push(interview);
        byPerson.set(interview.interviewerHrId, list);
      }
      for (const [hrId, list] of byPerson) {
        list.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
        const count = list.length;
        const lines = list.map((interview) => `${clockOf(interview)} — ${interview.candidateName} (${where(interview)})`);
        const dayText = formatDayLong(day);
        reminders.push({
          href: interviewCalendarHref({ base: PORTAL_BASE, weekStart: weekStartFor(day) }),
          key: `interview-reminder-evening:${hrId}:${day}:${fingerprint(list)}`,
          kind: "evening",
          message: `Your interviews on ${dayText}: ${lines.join("; ")}.`,
          metrics: lines.map((line, index) => ({ label: `Interview ${index + 1}`, value: line })),
          recipientHrId: hrId,
          subject: `Your ${count === 1 ? "interview" : `${count} interviews`} on ${dayText}`,
          title: `${count === 1 ? "1 interview" : `${count} interviews`} on ${dayText}`,
        });
      }
    }
  }

  return reminders;
}

export type InterviewReminderSend = (reminder: InterviewReminder) => Promise<boolean>;

/**
 * The channels each kind goes by. The evening list and the one-hour nudge use all three the owner
 * chose (in-app, email, Telegram). The "record what happened" pump repeats DAILY until the interviewer
 * responds, so it stays in-app + Telegram only — a daily e-mail for up to a month would be a nuisance,
 * and the pump is the one the owner described as "in-app and Telegram" (2026-09-23).
 */
export const sendInterviewReminder: InterviewReminderSend = async (reminder) => {
  const channels: Array<"in_app" | "email" | "telegram"> = reminder.kind === "awaiting" ? ["in_app", "telegram"] : ["in_app", "email", "telegram"];
  const result = await createSystemNotification({
    actionUrl: reminder.href,
    channels,
    email: {
      ctaHref: reminder.href,
      ctaLabel: "Open the interview calendar",
      employeeHrId: reminder.recipientHrId,
      metrics: reminder.metrics,
      notificationType: "general",
      recipientMode: "employee",
      subject: reminder.subject,
      summary: reminder.message,
      title: reminder.title,
    },
    eventType:
      reminder.kind === "hour"
        ? "interview_reminder_hour"
        : reminder.kind === "awaiting"
          ? "interview_awaiting_response"
          : "interview_reminder_evening",
    message: reminder.message,
    metadata: { idempotencyKey: reminder.key },
    module: "recruitment",
    priority: reminder.kind === "awaiting" ? "high" : "normal",
    recipientHrId: reminder.recipientHrId,
    title: reminder.title,
  });
  return result.deliveries.some((delivery) => delivery.status === "sent" || delivery.status === "pending" || delivery.status === "retrying");
};

export type InterviewReminderRun = { considered: number; planned: number; delivered: number; failed: number };

export async function runInterviewReminders(
  now: Date = new Date(),
  send: InterviewReminderSend = sendInterviewReminder,
  load: (from: Date, to: Date) => Promise<ReminderInterview[]> = listInterviewsToRemindAbout,
): Promise<InterviewReminderRun> {
  const interviews = await load(
    // Look back far enough to keep nagging about interviews already held but not yet responded to, and
    // ahead for the evening-before and one-hour reminders.
    new Date(now.getTime() - (AWAITING_PUMP_MAX_DAYS + 1) * 86_400_000),
    new Date(now.getTime() + (SEARCH_AHEAD_DAYS + 1) * 86_400_000),
  );
  const plan = planInterviewReminders(interviews, now);
  let delivered = 0;
  let failed = 0;
  for (const reminder of plan) {
    try {
      if (await send(reminder)) delivered += 1;
    } catch {
      failed += 1;
    }
  }
  return { considered: interviews.length, delivered, failed, planned: plan.length };
}
