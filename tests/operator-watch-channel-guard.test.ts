import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { operatorWatchBlocksTelegramFallback } from "../src/lib/notifications/operator-watch-channel-guard.ts";
import { stripComments } from "./support/comment-strip.ts";

// Imports the pure guard and reads the senders as text. It never reaches createSystemNotification, so this
// suite sends nothing.

type Alarm = {
  event: string;
  file: string;
  /** How the file spells the name when it is built at run time. Defaults to the name in double quotes. */
  spelledAs?: string;
};

const ALARMS: Alarm[] = [
  { event: "scheduled_job_stranded", file: "src/lib/observability/job-heartbeat-alert.ts" },
  { event: "notification_drain_stranded", file: "src/lib/notifications/drain-health-alert.ts" },
  { event: "database_restarted", file: "src/lib/observability/database-restart-alert.ts" },
  { event: "database_host_low_memory", file: "src/lib/observability/db-host-alert.ts", spelledAs: "`database_host_${kind}`" },
  { event: "database_host_low_root_disk", file: "src/lib/observability/db-host-alert.ts", spelledAs: "`database_host_${kind}`" },
  { event: "cv_lifecycle_link_expiring", file: "src/lib/recruitment/cv-lifecycle-link-expiry-alert.ts" },
  { event: "brick_move_net_unsettled", file: "src/lib/sales/master-data/brick-move-net-alert.ts" },
  { event: "brick_move_queue_stuck", file: "src/lib/sales/master-data/brick-move-stuck-alert.ts" },
  { event: "share_link_dead_token_polled", file: "src/lib/share-links/dead-token-polling-alert.ts" },
  { event: "notification_held_for_review", file: "src/lib/notifications/held-notification-alert.ts" },
  { event: "notification_holds_expired", file: "src/lib/notifications/held-notification-alert.ts" },
  { event: "ai_quota_exhausted", file: "src/lib/notifications/ai-quota-alert.ts" },
  { event: "ai_key_rejected", file: "src/lib/notifications/ai-quota-alert.ts" },
  { event: "system_audit_daily", file: "src/lib/system-audit/daily-message.ts" },
  { event: "activity_inactivity_digest", file: "src/lib/notifications/inactive-user-digest.ts" },
  { event: "attendance_punch_feed_stalled", file: "src/lib/attendance/punch-feed-stalled-telegram.ts" },
  { event: "background_jobs_run_failed", file: "src/lib/notifications/background-jobs-digest.ts", spelledAs: "`background_jobs_run_${input.status}`" },
  { event: "recruitment_whatsapp_intake_unhealthy", file: "src/lib/recruitment/inbound/recruitment-notify.ts" },
  { event: "recruitment_inbound_intake_dead_letter", file: "src/lib/recruitment/inbound/recruitment-notify.ts" },
  { event: "recruitment_inbound_intake_spike", file: "src/lib/recruitment/inbound/recruitment-notify.ts" },
  { event: "recruitment_stale_send_nudge", file: "src/lib/recruitment/stale-send-check.ts" },
  { event: "recruitment_stale_send_stranded", file: "src/lib/recruitment/stale-send-check.ts" },
  { event: "recruitment_triage_backlog", file: "src/lib/recruitment/triage-backlog-check.ts" },
  { event: "distributor_upload_overdue", file: "src/lib/sales/distributor-upload-nudge.ts" },
  { event: "field_capture_backlog", file: "src/lib/marketing-requests/field-capture-backlog.ts" },
  { event: "offer_accepted", file: "src/lib/offers/accepted-offer-alert.ts" },
  { event: "offer_accepted_team", file: "src/lib/offers/accepted-offer-alert.ts" },
  { event: "offer_joining_form_blocked", file: "src/lib/offers/accepted-offer-alert.ts" },
  { event: "retention_risk_flagged", file: "src/lib/retention-risk/messages.ts" },
  { event: "retention_risk_pre_payroll", file: "src/lib/retention-risk/messages.ts" },
];

// Senders on the system module that ask for Telegram without email and are NOT guarded, each with its reason.
const SYSTEM_SENDERS_LEFT_OUT: Record<string, string> = {
  "app/api/integrations/telegram/test/route.ts": "a test send he presses himself, not an alarm",
  "src/lib/milestones/notices.ts": "a reminder about people's milestones, with no ban on email",
  "src/lib/notifications/telegram-admin.ts": "a test send he presses himself, not an alarm",
  "src/lib/notifications/telegram-operations.ts": "the daily HR digest, with no ban on email",
  "src/lib/notifications/telegram-templates.ts": "a template preview he presses himself, not an alarm",
};

// Senders already guarded before this list grew, named so the census does not ask twice.
const SYSTEM_SENDERS_ALREADY_GUARDED = new Set([
  "src/lib/devices/headwind/fleet-watch-alert.ts",
  "src/lib/email/suppression-watch.ts",
  "src/lib/marketing-requests/sales-code-sync.ts",
  "src/lib/observability/github-workflow-watch-alert.ts",
]);

function channelLists(code: string): string[] {
  return (code.match(/\[[^[\]]*\]/g) ?? []).filter((list) => list.includes('"telegram"') || list.includes('"in_app"'));
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name).replace(/\\/g, "/"));
}

export function runOperatorWatchChannelGuardTests() {
  // Every alarm named is refused the email re-send.
  for (const alarm of ALARMS) {
    assert.equal(operatorWatchBlocksTelegramFallback(alarm.event), true, `${alarm.event}: a failed Telegram send never becomes an email`);
  }
  assert.equal(operatorWatchBlocksTelegramFallback("  SCHEDULED_JOB_STRANDED "), true, "case and stray spaces do not open the hole");

  // Notices that may still fall back, so the guard is a list and not a blanket.
  for (const open of [
    "request_submitted",
    "reminder_due",
    "plan_submitted",
    "mailbox_offboarding_overdue",
    "milestone_due",
    "daily_hr_digest",
    "background_jobs_run_success",
  ]) {
    assert.equal(operatorWatchBlocksTelegramFallback(open), false, `${open} keeps its fallback`);
  }
  // The three iReports360 sync alarms left with the vendor sync (7 Nov 2026): their sender was deleted, so
  // a name here would read as a guarded alarm while guarding nothing.
  for (const retired of ["ireports360_sync_failed", "ireports360_unmapped_agent", "ireports360_unrecognized_visit_type"]) {
    assert.equal(operatorWatchBlocksTelegramFallback(retired), false, `${retired} left the guard with the retired vendor sync`);
  }
  assert.doesNotMatch(
    stripComments(readFileSync("src/lib/notifications/operator-watch-channel-guard.ts", "utf8")),
    /["']ireports360_/,
    "no iReports360 event name is listed: the vendor's events have no sender",
  );
  assert.equal(operatorWatchBlocksTelegramFallback(null), false, "no event type is not a watch");
  assert.equal(operatorWatchBlocksTelegramFallback(""), false, "an empty event type is not a watch");

  // A name two modules share cannot join: the guard reads the event type alone.
  assert.equal(operatorWatchBlocksTelegramFallback("employee_added"), false, "the new-hire mailbox notice shares this name (as the retired CRM account setup notice did), and it emails");
  const setupKey = stripComments(readFileSync("src/lib/crm/account-setup-messages.ts", "utf8"));
  const mailboxKey = stripComments(readFileSync("src/lib/new-hire-mailbox/messages.ts", "utf8"));
  assert.match(setupKey, /CRM_ACCOUNT_SETUP_EVENT_TYPE = "employee_added"/, "the shared name is still shared");
  assert.match(mailboxKey, /NEW_HIRE_MAILBOX_EVENT_TYPE = "employee_added"/, "the shared name is still shared");

  // Each listed name is what the sender really uses, and the sender really asks for no email. A renamed
  // event would otherwise leave a dead entry here and the alarm open.
  for (const alarm of ALARMS) {
    const code = stripComments(readFileSync(alarm.file, "utf8"));
    const spelled = alarm.spelledAs ?? `"${alarm.event}"`;
    assert.ok(code.includes(spelled), `${alarm.file} still sends ${spelled}`);
    const lists = channelLists(code);
    assert.ok(lists.some((list) => list.includes('"telegram"')), `${alarm.file} asks for Telegram`);
    for (const list of lists) {
      assert.ok(!list.includes('"email"'), `${alarm.event}: ${alarm.file} asks for email in ${list}, so it does not belong in this guard`);
    }
  }

  // The kinds the database host alarm builds its two event names from.
  const hostKinds = stripComments(readFileSync("src/lib/observability/db-host-metrics.ts", "utf8"));
  assert.match(hostKinds, /DbHostAlarmKind = "low_memory" \| "low_root_disk"/, "a new host alarm kind needs its event in the guard");

  // The census: a new system-module sender asking for Telegram without email fails here until someone decides.
  const decided = new Set([...ALARMS.map((alarm) => alarm.file), ...Object.keys(SYSTEM_SENDERS_LEFT_OUT), ...SYSTEM_SENDERS_ALREADY_GUARDED]);
  const undecided: string[] = [];
  const found = new Set<string>();
  for (const file of [...sourceFiles("src"), ...sourceFiles("app")]) {
    const raw = readFileSync(file, "utf8");
    if (!raw.includes('"telegram"') || !raw.includes('"system"')) continue;
    const code = stripComments(raw);
    if (!/\bmodule: "system"/.test(code)) continue;
    const asksTelegramNotEmail = channelLists(code).some((list) => list.includes('"telegram"') && !list.includes('"email"'));
    if (!asksTelegramNotEmail) continue;
    found.add(file);
    if (!decided.has(file)) undecided.push(file);
  }
  assert.deepEqual(undecided, [], "a system-module sender asks for Telegram without email: add its event to operator-watch-channel-guard.ts, or exempt it above in writing");
  assert.ok(found.size >= 20, `the census must actually find the senders, and found ${found.size}`);
  for (const file of Object.keys(SYSTEM_SENDERS_LEFT_OUT)) {
    assert.ok(found.has(file), `${file} is exempted but no longer asks for Telegram without email on the system module: drop the exemption`);
  }
  for (const file of SYSTEM_SENDERS_ALREADY_GUARDED) {
    assert.ok(found.has(file), `${file} is named but no longer asks for Telegram without email on the system module: drop the name`);
  }
}
