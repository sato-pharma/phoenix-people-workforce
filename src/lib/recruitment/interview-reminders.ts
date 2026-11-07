// Recruitment — reminders to everyone on an interview's panel (owner, 2026-09-20; widened to the whole
// panel 2026-09-26).
//
// "The interviewer that I choose ... his interviews appears to him and send him reminders" — by all
// three channels (in-app, email, Telegram), on two clocks: the EVENING BEFORE at 5:00 PM Cairo with
// that day's whole list, and ONE HOUR BEFORE each interview. The lead interviewer AND every panel
// member get both; the source (listInterviewsToRemindAbout) returns one row per attendee, and the keys
// below carry the recipient so each attendee is delivered to independently. Only the LEAD is nagged to
// RECORD what happened, because only the lead (or the calendar owner) can set the outcome.
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
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { listInterviewsToRemindAbout, type ReminderInterview } from "@/lib/recruitment/interview-calendar";
import { interviewCalendarHref, mayConductInterview } from "@/lib/recruitment/interview-calendar-types";
import { INTERVIEW_OUTCOME_WINDOW_DAYS } from "@/lib/recruitment/interview-outcome-window";
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
export const AWAITING_PUMP_MAX_DAYS = INTERVIEW_OUTCOME_WINDOW_DAYS;
/** Not before this hour (Cairo) does the daily "record what happened" nag go out. */
export const AWAITING_PUMP_MINUTES = 9 * 60;

export type InterviewReminder = {
  kind: "evening" | "hour" | "awaiting";
  /** The message's idempotency key — the whole "sent already?" memory. */
  key: string;
  recipientHrId: string;
  title: string;
  /** The in-app + Telegram body — the readable list. */
  message: string;
  /** The e-mail's short intro line above the details table (the list lives in the table, not here,
   * so the e-mail reads as a premium zebra table rather than a run-on paragraph). */
  emailSummary: string;
  subject: string;
  href: string;
  /** Rows for the e-mail's zebra {{detailsTable}}: for the evening list, one row per interview
   * (time → candidate · where); for a single-interview reminder, the interview's own facts. */
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

/** The next interview day after `today` — every day is one since 7 Nov 2026, so it is tomorrow. */
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
  // District Managers and above — and, for the Medical Rep workflow's 1st round only, the HR interviewer
  // who conducts it (owner's email of 8 Nov 2026, §3), so the person holding the interview is reminded.
  const eligible = interviews.filter((interview) => mayConductInterview({ jobTitle: interview.interviewerJobTitle }, interview.round ?? null));
  const nowMs = now.getTime();

  // One hour before, for each interview on its own.
  for (const interview of eligible) {
    const minutesAway = (new Date(interview.startsAt).getTime() - nowMs) / 60_000;
    if (minutesAway <= 0 || minutesAway > HOUR_REMINDER_LEAD_MINUTES) continue;
    const time = clockOf(interview);
    reminders.push({
      href: linkTo(interview),
      key: `interview-reminder-hour:${interview.id}:${interview.startsAt}:${interview.interviewerHrId}`,
      kind: "hour",
      message: `Interview with ${interview.candidateName} at ${time} (${where(interview)}) — starting within the hour.`,
      emailSummary: `Your interview with ${interview.candidateName} starts within the hour.`,
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
      // Only the lead is nagged to record what happened — a panel member cannot set the outcome.
      if (!interview.isLead) continue;
      const startMs = new Date(interview.startsAt).getTime();
      const endMs = startMs + interview.durationMinutes * 60_000;
      if (endMs > nowMs) continue; // still ahead, or in progress — wait until it has actually ended
      const daysSince = (nowMs - startMs) / 86_400_000;
      if (daysSince > AWAITING_PUMP_MAX_DAYS) continue;
      const heldDay = formatDayLong(cairoDateKey(new Date(interview.startsAt)));
      reminders.push({
        href: linkTo(interview),
        key: `interview-reminder-awaiting:${interview.id}:${todayKey}:${interview.interviewerHrId}`,
        kind: "awaiting",
        message: `Your interview with ${interview.candidateName} (${heldDay}) is waiting for your response — record what happened on the interview calendar.`,
        emailSummary: `Your interview with ${interview.candidateName} (${heldDay}) is waiting for your response — record what happened.`,
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
        const dayText = formatDayLong(day);
        // In-app + Telegram: the list, one interview per line (tidy, not a semicolon run-on).
        const message = `Your interviews on ${dayText}:\n${list.map((interview) => `• ${clockOf(interview)} — ${interview.candidateName} (${where(interview)})`).join("\n")}`;
        reminders.push({
          href: interviewCalendarHref({ base: PORTAL_BASE, weekStart: weekStartFor(day) }),
          key: `interview-reminder-evening:${hrId}:${day}:${fingerprint(list)}`,
          kind: "evening",
          message,
          // E-mail: a short intro, then the list as a premium zebra table (time → candidate · where).
          emailSummary: `You have ${count === 1 ? "one interview" : `${count} interviews`} on ${dayText} — the times are below.`,
          metrics: list.map((interview) => ({ label: clockOf(interview), value: `${interview.candidateName} · ${where(interview)}` })),
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
export function reminderChannels(reminder: Pick<InterviewReminder, "kind">): Array<"in_app" | "email" | "telegram"> {
  return reminder.kind === "awaiting" ? ["in_app", "telegram"] : ["in_app", "email", "telegram"];
}

export const sendInterviewReminder: InterviewReminderSend = async (reminder) => {
  const channels = reminderChannels(reminder);
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
      summary: reminder.emailSummary,
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

/**
 * Which planned reminders have NOTHING left to do. A reminder's key is the event key of its notice,
 * and a delivery row for a channel means that channel was already claimed — sent, skipped, or handed
 * to a retry worker — which is exactly the case where `createSystemNotification` would claim nothing
 * and send nothing. So a reminder whose event already holds a delivery row for EVERY channel it asks
 * for is settled; one with a channel still missing (a run that died half-way) is not, and goes through
 * the normal path so that channel is still delivered. Pure: the two reads are handed in.
 */
export function settledReminderKeys(
  reminders: readonly Pick<InterviewReminder, "kind" | "key">[],
  events: ReadonlyArray<{ id: string; event_key: string }>,
  deliveries: ReadonlyArray<{ notification_event_id: string; channel: string }>,
): Set<string> {
  const channelsByEvent = new Map<string, Set<string>>();
  for (const delivery of deliveries) {
    const id = String(delivery.notification_event_id);
    const seen = channelsByEvent.get(id) ?? new Set<string>();
    seen.add(delivery.channel);
    channelsByEvent.set(id, seen);
  }
  const eventIdByKey = new Map(events.map((event) => [event.event_key, String(event.id)]));
  const settled = new Set<string>();
  for (const reminder of reminders) {
    const id = eventIdByKey.get(reminder.key);
    const seen = id ? channelsByEvent.get(id) : undefined;
    if (seen && reminderChannels(reminder).every((channel) => seen.has(channel))) settled.add(reminder.key);
  }
  return settled;
}

const SETTLED_READ_CHUNK = 40;

/**
 * Reads, in a few parallel round trips, what `settledReminderKeys` needs. Fails OPEN: any error
 * answers "nothing is settled", so every reminder takes the full, idempotent path as before.
 */
export async function loadSettledReminderKeys(reminders: readonly InterviewReminder[]): Promise<Set<string>> {
  if (reminders.length === 0) return new Set();
  try {
    const db = getSupabaseAdmin();
    const keys = Array.from(new Set(reminders.map((reminder) => reminder.key)));
    const eventChunks = await Promise.all(
      chunk(keys, SETTLED_READ_CHUNK).map(async (slice) => {
        const { data, error } = await db.from("notification_events").select("id,event_key").in("event_key", slice);
        if (error) throw error;
        return (data ?? []) as Array<{ id: string; event_key: string }>;
      }),
    );
    const events = eventChunks.flat();
    const deliveryChunks = await Promise.all(
      chunk(
        events.map((event) => String(event.id)),
        SETTLED_READ_CHUNK,
      ).map(async (slice) => {
        const { data, error } = await db.from("notification_deliveries").select("notification_event_id,channel").in("notification_event_id", slice);
        if (error) throw error;
        return (data ?? []) as Array<{ notification_event_id: string; channel: string }>;
      }),
    );
    return settledReminderKeys(reminders, events, deliveryChunks.flat());
  } catch {
    return new Set();
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** How many reminders are sent at once. Each send is ~10 database round trips, so a sequential run of a
 * few dozen new ones outlives the scheduler's 30-second cut; four at a time stays well inside the
 * mail provider's and Telegram's limits. */
export const REMINDER_SEND_CONCURRENCY = 4;

export type InterviewReminderRun = { considered: number; planned: number; settled: number; delivered: number; failed: number };

export async function runInterviewReminders(
  now: Date = new Date(),
  send: InterviewReminderSend = sendInterviewReminder,
  load: (from: Date, to: Date) => Promise<ReminderInterview[]> = listInterviewsToRemindAbout,
  // Only the real sender has delivery rows to look at; an injected one (a test's) is asked about all.
  findSettled: (reminders: readonly InterviewReminder[]) => Promise<Set<string>> = send === sendInterviewReminder
    ? loadSettledReminderKeys
    : async () => new Set(),
): Promise<InterviewReminderRun> {
  const interviews = await load(
    // Look back far enough to keep nagging about interviews already held but not yet responded to, and
    // ahead for the evening-before and one-hour reminders.
    new Date(now.getTime() - (AWAITING_PUMP_MAX_DAYS + 1) * 86_400_000),
    new Date(now.getTime() + (SEARCH_AHEAD_DAYS + 1) * 86_400_000),
  );
  const plan = planInterviewReminders(interviews, now);
  // The "record what happened" nag is planned afresh on every ten-minute run for every unrecorded
  // interview of the last 14 days, and almost all of it was delivered hours ago. Re-sending an
  // already-delivered key re-reads the person's profile and preferences, rewrites the notice and
  // its audit row and re-claims three channels — about ten round trips for nothing — so only the
  // reminders with something left to deliver are sent, and those a few at a time.
  const settled = await findSettled(plan);
  const pending = plan.filter((reminder) => !settled.has(reminder.key));
  let delivered = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const reminder = pending[next];
      next += 1;
      try {
        if (await send(reminder)) delivered += 1;
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REMINDER_SEND_CONCURRENCY, pending.length) }, worker));
  return { considered: interviews.length, delivered, failed, planned: plan.length, settled: plan.length - pending.length };
}
