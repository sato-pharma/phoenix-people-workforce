import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  daysOpen,
  overdueTasks,
  reminderMessage,
  REMINDER_AFTER_DAYS,
} from "../src/lib/crm/account-setup-reminder.ts";
import type { CrmAccountSetupTaskRow } from "../src/lib/crm/account-setup.ts";

/**
 * The reminder for a CRM account task nobody acted on.
 *
 * `account-setup-notify.ts` speaks ONCE, when the employee is added, and never again. Measured
 * 2026-09-28: seven tasks open, the oldest eight days, and five medical reps unable to use Phoenix
 * CRM at all because of them — no iReports360 account means no contacts to carry over, no customer
 * list, and so no way to plan or record a visit. Nothing was red anywhere; the one notice had
 * scrolled away days earlier.
 *
 * What this pins, in the order a failure would cost most:
 *
 *   1. A CLEAN QUEUE TELLS NOBODY, and neither does a task opened today. A reminder that arrives
 *      every morning whatever the state is muted inside a week — the owner's own ruling on the 06:55
 *      CRM digest, and the reason that digest now waits for a territory's first real use.
 *   2. NEVER EMAIL. The first notice already emails; a second daily email about the same person is
 *      what gets the whole module filtered.
 *   3. NO SCHEDULE OF ITS OWN. A JOB_SCHEDULES declaration whose cron job does not exist reads to
 *      job-heartbeat-assess as a job that has STOPPED and Telegrams every Super Admin for ever.
 */
export function runCrmAccountSetupReminderTests(): void {
  const source = (path: string) => stripComments(readFileSync(path, "utf8"));

  const task = (name: string, openedAt: string, area: string | null = "Minia 1", line: string | null = "Pedia"): CrmAccountSetupTaskRow =>
    ({
      crmId: null,
      crmUsername: null,
      employeeFound: true,
      employmentStatus: "active",
      id: name,
      openedAt,
      resolutionNote: null,
      resolvedAt: null,
      resolvedByHrId: null,
      source: "manual_add",
      status: "pending",
      subject: {
        areaName: area,
        displayName: name,
        hireDate: null,
        hrId: `PD-${name.length}`,
        jobTitle: "Medical Representative",
        lineName: line,
        managerName: null,
        mobileNumber: null,
        regionName: null,
        workEmail: null,
      },
    }) as CrmAccountSetupTaskRow;

  // ── 1. The age arithmetic ───────────────────────────────────────────────────────────────────────
  {
    assert.equal(daysOpen("2026-09-20", "2026-09-28"), 8, "eight whole days");
    assert.equal(daysOpen("2026-09-28", "2026-09-28"), 0, "opened today is nothing yet");
    assert.equal(daysOpen("2026-09-28T23:45:00+00:00", "2026-09-28"), 0, "a timestamp is read by its DAY, not its clock");
    assert.equal(daysOpen("2026-09-29", "2026-09-28"), 0, "clock skew never reads as a negative age");
    assert.equal(daysOpen("", "2026-09-28"), 0, "an unparseable date is 0, never NaN on a manager's screen");
  }

  // ── 2. 🔴 A clean queue, and a fresh task, tell NOBODY ───────────────────────────────────────────
  {
    assert.equal(REMINDER_AFTER_DAYS, 2, "a task is late after two days, not on the day it opens");
    assert.deepEqual(overdueTasks([], "2026-09-28"), [], "an empty queue is the good outcome and says nothing");
    assert.deepEqual(
      overdueTasks([task("Opened today", "2026-09-28"), task("Opened yesterday", "2026-09-27")], "2026-09-28"),
      [],
      "the first notice is still the freshest thing said — a reminder now would only teach him to ignore it",
    );

    const overdue = overdueTasks(
      [task("Newest", "2026-09-26"), task("Oldest", "2026-09-20"), task("Today", "2026-09-28"), task("Middle", "2026-09-24")],
      "2026-09-28",
    );
    assert.deepEqual(overdue.map((row) => row.subject.displayName), ["Oldest", "Middle", "Newest"], "oldest first, and today's is not there at all");
  }

  // ── 3. The words say the cost, not just the count ───────────────────────────────────────────────
  {
    const text = reminderMessage(overdueTasks([task("Jonia Wageh", "2026-09-20"), task("Merna Magdy", "2026-09-24", "Assuit 1")], "2026-09-28"), "2026-09-28");
    assert.match(text, /2 new people are still waiting/, "the count opens it");
    assert.match(text, /• Jonia Wageh — Minia 1 · Pedia — waiting 8 days/, "each person, where, and how long");
    assert.match(text, /• Merna Magdy — Assuit 1 · Pedia — waiting 4 days/);
    assert.ok(text.indexOf("Jonia Wageh") < text.indexOf("Merna Magdy"), "oldest first in the words too");
    assert.match(text, /can neither plan a visit nor record one/, "WHY it matters, in a sentence a non-engineer acts on");
    assert.match(text, /CRM username and code/, "and what to actually do");

    const single = reminderMessage(overdueTasks([task("Solo", "2026-09-20")], "2026-09-28"), "2026-09-28");
    assert.match(single, /1 new person is still waiting/, "one person reads as one person");
    assert.match(single, /waiting 8 days/);
    const oneDay = reminderMessage([task("Solo", "2026-09-26")], "2026-09-27");
    assert.match(oneDay, /waiting 1 day\b/, "one day is not '1 days'");
  }

  // ── 4. Never email, and one send per day ────────────────────────────────────────────────────────
  {
    const reminder = source("src/lib/crm/account-setup-reminder.ts");
    assert.ok(/channels: \["in_app", "telegram"\],/.test(reminder), "in-app and Telegram");
    assert.ok(!/"email"/.test(reminder), "the reminder must never name the email channel — the first notice already emails");
    assert.ok(
      /idempotencyKey: `crm_account_setup:reminder:\$\{cairoToday\}`/.test(reminder),
      "keyed per DAY, so a second run of the daily job cannot send it twice and tomorrow's is still new",
    );
    assert.ok(/resolveNotificationPersonRecipients\(CRM_ACCOUNT_SETUP_AUDIENCE/.test(reminder), "the audience is the admin-editable policy, never a hardcoded person");
  }

  // ── 5. It rides the daily job and declares no schedule ──────────────────────────────────────────
  {
    assert.ok(
      !/crm[-_]account[-_]setup/i.test(source("src/lib/observability/job-schedule.ts")),
      "NO JOB_SCHEDULES entry: a declaration with no cron job behind it reads as a STOPPED job and pages every Super Admin for ever",
    );
    const daily = source("app/api/notifications/daily/route.ts");
    assert.ok(/runCrmAccountSetupReminder\(\)\.catch\(/.test(daily), "it runs in the daily job, with its own catch like every other pass");
    assert.ok(/const totalJobs = 28;/.test(daily), "the hand-maintained sub-job count is bumped, or the run summary silently under-reports");
    // APPENDED, never inserted: the file records two real off-by-one incidents from doing otherwise.
    const destructure = daily.slice(daily.indexOf("  const ["), daily.indexOf("] = await Promise.all(["));
    assert.ok(/needsYouWeeklyEmail,\s*crmAccountSetupReminder,\s*$/.test(destructure), "named LAST in the destructure, after position 27");
  }
}
