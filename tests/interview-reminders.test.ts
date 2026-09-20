import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ReminderInterview } from "../src/lib/recruitment/interview-calendar.ts";
import { cairoLocalToUtc } from "../src/lib/recruitment/interview-calendar-week.ts";
import {
  nextWorkingDayAfter,
  planInterviewReminders,
  runInterviewReminders,
  type InterviewReminder,
} from "../src/lib/recruitment/interview-reminders.ts";
import { stripComments } from "./support/comment-strip.ts";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

// Interview reminders (owner, 2026-09-20): "send him reminders" — in-app, email and Telegram; the
// evening before at 5:00 PM Cairo with the day's list, and one hour before each interview.

// 2026-09-22 is a Tuesday, 2026-09-24 a Thursday, 2026-09-27 a Sunday.
const at = (day: string, hour: number, minute = 0) => cairoLocalToUtc(day, hour * 60 + minute);

function interview(id: string, day: string, hour: number, overrides: Partial<ReminderInterview> = {}): ReminderInterview {
  return {
    candidateName: `Candidate ${id}`,
    durationMinutes: 30,
    id,
    interviewerHrId: "D-07",
    interviewerJobTitle: "District Sales Manager",
    platform: "zoom",
    startsAt: at(day, hour).toISOString(),
    ...overrides,
  };
}

function kinds(plan: InterviewReminder[]) {
  return plan.map((reminder) => `${reminder.kind}:${reminder.recipientHrId}`).sort();
}

export async function runInterviewReminderTests() {
  // ONE HOUR BEFORE: from an hour out until the start, never before and never after.
  const eleven = interview("a", "2026-09-22", 11);
  assert.deepEqual(kinds(planInterviewReminders([eleven], at("2026-09-22", 9, 55))), [], "more than an hour ahead: not yet");
  const hourPlan = planInterviewReminders([eleven], at("2026-09-22", 10, 3));
  assert.deepEqual(kinds(hourPlan), ["hour:D-07"], "inside the hour: one reminder");
  assert.match(hourPlan[0].message, /Candidate a at 11:00 AM \(Zoom\)/, "it says who, when and where — in Cairo time");
  assert.deepEqual(kinds(planInterviewReminders([eleven], at("2026-09-22", 11, 1))), [], "after it started: nothing");
  const office = planInterviewReminders([interview("b", "2026-09-22", 11, { platform: "in_office" })], at("2026-09-22", 10, 10));
  assert.ok(office[0].message.includes("In office"), "an office interview says so");

  // The key is the whole memory: stable across runs, fresh when the interview MOVES.
  const again = planInterviewReminders([eleven], at("2026-09-22", 10, 13));
  assert.equal(again[0].key, hourPlan[0].key, "the next run asks for the same key, so nobody is told twice");
  const moved = planInterviewReminders([{ ...eleven, startsAt: at("2026-09-22", 12).toISOString() }], at("2026-09-22", 11, 3));
  assert.notEqual(moved[0].key, hourPlan[0].key, "a moved interview is reminded about again at its new time");

  // THE EVENING BEFORE: from 5:00 PM Cairo, one list per interviewer for the next working day.
  const tomorrow = [interview("c", "2026-09-23", 13), interview("d", "2026-09-23", 10), interview("e", "2026-09-23", 9, { interviewerHrId: "D-08" })];
  assert.deepEqual(kinds(planInterviewReminders(tomorrow, at("2026-09-22", 16, 53))), [], "before 5:00 PM: no list yet");
  const evening = planInterviewReminders(tomorrow, at("2026-09-22", 17, 3));
  assert.deepEqual(kinds(evening), ["evening:D-07", "evening:D-08"], "one list per interviewer");
  const seven = evening.find((reminder) => reminder.recipientHrId === "D-07");
  assert.ok(seven && seven.message.indexOf("10:00 AM") < seven.message.indexOf("1:00 PM"), "the list is in time order");
  assert.match(seven?.title ?? "", /^2 interviews on /, "and counts them");
  assert.deepEqual(kinds(planInterviewReminders(tomorrow, at("2026-09-22", 23, 50))), ["evening:D-07", "evening:D-08"], "the list keeps being asked for until midnight (deduped by its key)");
  assert.deepEqual(kinds(planInterviewReminders(tomorrow, at("2026-09-23", 0, 10))), [], "and stops at midnight");
  assert.deepEqual(kinds(planInterviewReminders([interview("f", "2026-09-24", 10)], at("2026-09-22", 17, 5))), [], "the day after tomorrow is not on tomorrow's list");

  // Thursday evening looks to Sunday, since the calendar has no Friday or Saturday.
  assert.equal(nextWorkingDayAfter("2026-09-24"), "2026-09-27", "Thursday looks to Sunday");
  assert.equal(nextWorkingDayAfter("2026-09-25"), "2026-09-27", "Friday looks to Sunday");
  assert.equal(nextWorkingDayAfter("2026-09-22"), "2026-09-23", "Tuesday looks to Wednesday");
  assert.deepEqual(kinds(planInterviewReminders([interview("g", "2026-09-27", 10)], at("2026-09-24", 17, 30))), ["evening:D-07"], "Sunday's interviews are listed on Thursday evening");

  // The list's key changes only when the list does: a booking added after 5 PM sends it again.
  const first = planInterviewReminders(tomorrow, at("2026-09-22", 17, 3)).find((r) => r.recipientHrId === "D-07");
  const same = planInterviewReminders(tomorrow, at("2026-09-22", 18, 43)).find((r) => r.recipientHrId === "D-07");
  const grown = planInterviewReminders([...tomorrow, interview("h", "2026-09-23", 15)], at("2026-09-22", 18, 43)).find((r) => r.recipientHrId === "D-07");
  assert.equal(same?.key, first?.key, "an unchanged list never repeats");
  assert.notEqual(grown?.key, first?.key, "a changed list is sent once more");

  // WHO: a District Manager or above only — a Medical Rep chosen earlier is never reminded.
  const rep = interview("i", "2026-09-22", 11, { interviewerHrId: "R-01", interviewerJobTitle: "Medical Representative" });
  assert.deepEqual(kinds(planInterviewReminders([rep], at("2026-09-22", 10, 3))), [], "no reminder for a Medical Rep");
  assert.deepEqual(kinds(planInterviewReminders([{ ...rep, startsAt: at("2026-09-23", 11).toISOString() }], at("2026-09-22", 17, 3))), [], "and no evening list for one");

  // The run: sends each planned reminder, counts what went out, survives one failing.
  const sent: string[] = [];
  const run = await runInterviewReminders(
    at("2026-09-22", 17, 3),
    async (reminder) => {
      if (reminder.recipientHrId === "D-08") throw new Error("Telegram exploded");
      sent.push(reminder.key);
      return true;
    },
    async () => tomorrow,
  );
  assert.deepEqual(
    { considered: run.considered, delivered: run.delivered, failed: run.failed, planned: run.planned },
    { considered: 3, delivered: 1, failed: 1, planned: 2 },
    "one failing send does not stop the others",
  );
  assert.equal(sent.length, 1);

  // WIRING: the three channels the owner named, once by key, and nothing but the interviewer is told.
  const source = stripComments(read("src/lib/recruitment/interview-reminders.ts"));
  assert.match(source, /channels: \["in_app", "email", "telegram"\]/, "in-app, email and Telegram — all three");
  assert.match(source, /idempotencyKey: reminder\.key/, "every message is deduped by its key");
  assert.match(source, /recipientHrId: reminder\.recipientHrId/, "and goes to the interviewer only");
  assert.doesNotMatch(source, /candidateEmail|recipientMode: "candidate"/, "the candidate is sent nothing");
  const route = stripComments(read("app/api/cron/interview-reminders/route.ts"));
  assert.match(route, /assertCronAuthorized\(request, "cron\/interview-reminders"\)/, "the cron route checks the secret");
  assert.match(route, /export async function POST/, "and answers the scheduler's POST too");
  assert.match(
    read("src/lib/observability/job-schedule.ts"),
    /"phoenix-interview-reminders", kind: "cron", schedule: "3,13,23,33,43,53 \* \* \* \*"/,
    "declared to the heartbeat register on the ten-minute clock",
  );
  assert.match(read("scripts/cronjob-sync.mjs"), /minutes: \[3, 13, 23, 33, 43, 53\]/, "and to the scheduler, on the same minutes");
}
