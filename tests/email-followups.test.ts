import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyMarketingSla } from "@/lib/marketing-requests/service.ts";

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
  assert.equal(classifyMarketingSla({ payDate: "2026-06-06", today }), "escalation", "3+ days overdue → escalation");
  assert.equal(classifyMarketingSla({ payDate: "not-a-date", today }), null, "unparseable date → null");

  // --- W1: migration guard (source-pattern) ----------------------------------------
  const migration = readFileSync(
    "supabase/migrations/20260609000000_notification_outbox_add_skipped_status.sql",
    "utf8",
  );
  assert.match(migration, /information_schema\.columns/, "migration must guard on column existence");
  assert.match(migration, /column_name = 'status'/, "guard checks the status column");
  assert.match(migration, /'skipped'/, "widened CHECK still adds 'skipped'");

  // --- W2: interview templates (source-pattern) ------------------------------------
  const interviewNotif = readFileSync("src/lib/recruitment/interview-notifications.ts", "utf8");
  assert.match(interviewNotif, /sendTemplatedEmail/, "interview emails use the template sender");
  assert.match(interviewNotif, /EMAIL_TEMPLATE_KEYS\.INTERVIEW_INVITATION/, "scheduled/rescheduled use the invitation template");
  assert.match(interviewNotif, /export async function notifyInterviewFeedback/, "feedback notifier exists");
  assert.match(interviewNotif, /EMAIL_TEMPLATE_KEYS\.INTERVIEW_FEEDBACK/, "feedback uses the feedback template");
  const interviews = readFileSync("src/lib/recruitment/interviews.ts", "utf8");
  assert.match(interviews, /notifyInterviewFeedback\(/, "recordInterviewOutcome fires interview feedback");

  // --- W3: marketing SLA (source-pattern) ------------------------------------------
  const marketing = readFileSync("src/lib/marketing-requests/service.ts", "utf8");
  assert.match(marketing, /export async function runMarketingSlaDaily/, "daily SLA scan exists");
  assert.match(marketing, /export function classifyMarketingSla/, "SLA classifier is exported");
  assert.match(marketing, /Sentry\.captureException/, "marketing notify failures are surfaced (no longer silent)");
  const dailyRoute = readFileSync("app/api/notifications/daily/route.ts", "utf8");
  assert.match(dailyRoute, /runMarketingSlaDaily\(\)/, "marketing SLA is wired into the daily cron");
}
