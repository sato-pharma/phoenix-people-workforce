// Owner rule (2026-11-03): the watches built for him add no outbound email. They ask for in-app, Telegram
// and push, and the one way an email could still go out is the Telegram-failure fallback, which re-sends a
// failed Telegram notice as ["email", "in_app", "push"]. The in-app and push copies already went with the
// first send, so the only thing that re-send adds here is the email that must not happen, and the whole
// fallback is skipped. Same shape as closingPublishBlocksTelegramFallback.
//
// Explicit channels win over the policy table, so a row saying "no email" does not stop this re-send, and
// neither does the channel list at the call site. A notice that must never email has to be named here,
// unless a guard of its own already strips email (Phoenix CRM, Early Birds, the CV notices, the marketing
// reminders). tests/operator-watch-channel-guard.test.ts refuses a new system-module sender that asks for
// Telegram without email until it is either listed here or exempted in writing.
//
// Keyed on the event type alone, so a name two modules share cannot join: `employee_added` is both the new
// hire mailbox notice, which never emails, and the CRM account setup task, which does.

const OPERATOR_WATCH_EVENTS: ReadonlySet<string> = new Set([
  // Built for him on 3 Nov 2026.
  "email_block_new",
  "github_workflow_overdue",
  "marketing_pharmacy_code_sync_notice",
  "tablet_fleet_watch",
  "whatsapp_handset_echoes_off",
  "whatsapp_handset_open_reminder",

  // System alarms. Most report a fault in the path an email would travel, or could re-enter it: the drain
  // alarm is documented as deliberately never email (docs/environment.md, AGENTS.md section 3).
  "activity_inactivity_digest",
  "ai_key_rejected",
  // The Telegram half of the punch-feed alarm (13 Nov 2026). Its in-app half was written as never
  // email on 2026-08-08 and 2026-08-09 (attendance-alert-channel-guard.ts); this holds the same rule
  // on the one path that guard cannot see, a failed Telegram send.
  "attendance_punch_feed_stalled",
  "ai_quota_exhausted",
  "brick_move_net_unsettled",
  "brick_move_queue_stuck",
  "cv_lifecycle_link_expiring",
  "database_host_low_memory",
  "database_host_low_root_disk",
  "database_restarted",
  "notification_drain_stranded",
  "notification_held_for_review",
  "notification_holds_expired",
  "scheduled_job_stranded",
  "share_link_dead_token_polled",
  "system_audit_daily",

  // Same audience and the same three channels, with no written ban: no feature may add an outbound email.
  // The three iReports360 sync alarms (`ireports360_sync_failed`, `_unmapped_agent`,
  // `_unrecognized_visit_type`) stood here until 7 Nov 2026: their sender was deleted with the vendor
  // sync, so nothing could raise them any more (tests/operator-watch-channel-guard.test.ts).
  "background_jobs_run_failed",

  // Recruitment alarms and nudges, each written as never email in its own file.
  "recruitment_inbound_intake_dead_letter",
  "recruitment_inbound_intake_spike",
  "recruitment_stale_send_nudge",
  "recruitment_stale_send_stranded",
  "recruitment_triage_backlog",
  "recruitment_whatsapp_intake_unhealthy",

  // Daily lateness jobs: a failed Telegram round would otherwise become bulk email.
  "distributor_upload_overdue",
  "field_capture_backlog",

  // Owner's words, 2026-09-07 and 2026-10-02. Their modules' Telegram is off today, so nothing can fail yet;
  // this holds the day it is switched on. The retention alert names a colleague as a resignation risk.
  "offer_accepted",
  "offer_accepted_team",
  "offer_joining_form_blocked",
  "retention_risk_flagged",
  "retention_risk_pre_payroll",
]);

/** Whether a FAILED Telegram delivery may be covered by the email/in-app/push re-send. False for these notices. */
export function operatorWatchBlocksTelegramFallback(eventType?: string | null): boolean {
  return OPERATOR_WATCH_EVENTS.has(String(eventType ?? "").trim().toLowerCase());
}
