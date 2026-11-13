import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyMarketingSla,
  classifyMarketingWaitingSla,
  marketingDaysWaiting,
  mostUrgentMarketingSla,
} from "@/lib/marketing-requests/service.ts";

/**
 * Email follow-ups: migration guard, interview templates, marketing SLA.
 */
export function runEmailFollowupsTests() {
  // --- Marketing SLA classifier (behavioral) ---------------------------------------
  const today = "2026-06-09";
  assert.equal(classifyMarketingSla({ payDate: null, today }), null, "no pay date → null");
  assert.equal(classifyMarketingSla({ payDate: "2026-06-20", today }), null, "comfortably before due → null");
  assert.equal(classifyMarketingSla({ payDate: "2026-06-11", today }), "due_date_reminder", "within 3 days → reminder");
  assert.equal(classifyMarketingSla({ payDate: "2026-06-09", today }), "due_date_reminder", "due today → reminder");
  assert.equal(classifyMarketingSla({ payDate: "2026-06-08", today }), "overdue_reminder", "1 day overdue → overdue");
  assert.equal(classifyMarketingSla({ payDate: "2026-06-07", today }), "overdue_reminder", "2 days overdue → overdue");
  assert.equal(classifyMarketingSla({ payDate: "2026-06-06", today }), "overdue_reminder", "3+ days overdue → still overdue (no separate escalation tier)");
  assert.equal(classifyMarketingSla({ payDate: "not-a-date", today }), null, "unparseable date → null");

  // --- Waiting-time SLA (the other clock) ------------------------------------------
  // The pay-date rule cannot see a request that is simply stuck: one with a pay date months out
  // stays silent however long an approver holds it. This measures time-in-step instead.
  const now = "2026-06-09T12:00:00.000Z";
  const daysAgo = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();

  assert.equal(classifyMarketingWaitingSla({ now, waitingSince: null }), null, "no step timestamp → null");
  assert.equal(classifyMarketingWaitingSla({ now, waitingSince: daysAgo(2) }), null, "2 days waiting → nothing yet");
  assert.equal(
    classifyMarketingWaitingSla({ now, waitingSince: daysAgo(3) }),
    "due_date_reminder",
    "3 days waiting → nudge",
  );
  assert.equal(
    classifyMarketingWaitingSla({ now, waitingSince: daysAgo(7) }),
    "overdue_reminder",
    "7 days waiting → overdue",
  );
  assert.equal(
    classifyMarketingWaitingSla({ now, waitingSince: daysAgo(14) }),
    "overdue_reminder",
    "14 days waiting → still overdue (no separate escalation tier)",
  );
  assert.equal(
    classifyMarketingWaitingSla({ now, waitingSince: "not-a-date" }),
    null,
    "unparseable step timestamp → null, never a false alarm",
  );

  // A request can trigger both clocks; it must produce ONE notification, the worse of the two.
  assert.equal(mostUrgentMarketingSla(null, null), null, "neither clock → nothing");
  assert.equal(mostUrgentMarketingSla("due_date_reminder", null), "due_date_reminder", "one clock only");
  assert.equal(
    mostUrgentMarketingSla("due_date_reminder", "overdue_reminder"),
    "overdue_reminder",
    "the worse signal wins, regardless of argument order",
  );
  assert.equal(mostUrgentMarketingSla("overdue_reminder", "due_date_reminder"), "overdue_reminder", "order does not matter");

  // The day count is stated in the message, so it must not go negative on a future timestamp.
  assert.equal(marketingDaysWaiting(daysAgo(5), now), 5, "whole days waiting");
  assert.equal(marketingDaysWaiting(daysAgo(-3), now), 0, "a future timestamp floors at 0, never negative");
  assert.equal(marketingDaysWaiting(null, now), null, "no timestamp → null");

  // --- W1: migration guard (source-pattern) ----------------------------------------
  const migration = readFileSync(
    "supabase/_migrations_archive/pre-baseline-2026-07-11/20260609000000_notification_outbox_add_skipped_status.sql",
    "utf8",
  );
  assert.match(migration, /information_schema\.columns/, "migration must guard on column existence");
  assert.match(migration, /column_name = 'status'/, "guard checks the status column");
  assert.match(migration, /'skipped'/, "widened CHECK still adds 'skipped'");

  // --- W2: interview templates (source-pattern) ------------------------------------
  const interviewNotif = readFileSync("src/lib/recruitment/interview-notifications.ts", "utf8");
  // REC-048: the template sender is now reached through the durable outbox (sendDurableEmail with
  // sender: "templated") — still the template sender, now retried if the provider fails.
  assert.match(interviewNotif, /sendDurableEmail\([\s\S]*?sender: "templated"/, "interview emails use the template sender, through the durable outbox");
  assert.match(interviewNotif, /EMAIL_TEMPLATE_KEYS\.INTERVIEW_INVITATION/, "scheduled/rescheduled use the invitation template");
  assert.match(interviewNotif, /export async function notifyInterviewFeedback/, "feedback notifier exists");
  assert.match(interviewNotif, /EMAIL_TEMPLATE_KEYS\.INTERVIEW_FEEDBACK/, "feedback uses the feedback template");
  const interviews = readFileSync("src/lib/recruitment/interviews.ts", "utf8");
  assert.match(interviews, /notifyInterviewFeedback\(/, "recordInterviewOutcome fires interview feedback");

  // --- W3: marketing SLA (source-pattern) ------------------------------------------
  const marketing = readFileSync("src/lib/marketing-requests/service.ts", "utf8");
  assert.match(marketing, /export async function runMarketingSlaDaily/, "daily SLA scan exists");
  assert.match(marketing, /export function classifyMarketingSla/, "SLA classifier is exported");
  assert.match(marketing, /logError/, "marketing notify failures are surfaced (no longer silent)");
  const dailyRoute = readFileSync("app/api/cron/daily/_lib/daily-job-runners.ts", "utf8");
  assert.match(dailyRoute, /runMarketingSlaDaily\(\)/, "marketing SLA reminder/escalation is restored behind a real admin toggle (see marketing_sla_reminder in role-recipients.ts), not stubbed out");
}
