// The one registry of notification types (audit item REC-084).
//
// Every notice the system sends with a type is listed here, keyed by `module` + `eventType` exactly
// as the send passes them, with a plain-English `label` (what the notice tells the person) and
// `sentFrom` (the file(s) that send it). Channels and recipients are NOT restated here: the screen
// at /admin/notification-types and anything else that lists types derive them from
// `resolveNotificationPolicy`, so the policy table stays the one truth for how a type is delivered.
//
// `delivery` says which road a type takes:
//   - absent         → the notification engine (createSystemNotification and its wrappers); the
//                      policy decides channels and recipients, a sender may name a narrower set.
//   - "direct_email" → a single email built and sent directly (sendPhoenixEmail / sendTemplatedEmail
//                      with an `origin`), outside the policy: To/CC are named by the sender.
//   - "both"         → sent both ways.
//
// tests/notification-type-registry.test.ts holds this file true: it reads every send in `src/` and
// `app/` and fails when a sent type is missing here, when an entry here is sent nowhere, when a
// `sentFrom` is wrong, and when a policy row names a type nobody sends without saying so.
//
// Types built at run time are listed with every value they can take; each such group says how in a
// comment. Sends that carry no type at all (the composers, the Telegram bot's replies, mirrors) are
// in `UNTYPED_SENDS` at the foot of the file.

import {
  resolveNotificationPolicy,
  type NotificationPolicy,
  type NotificationRecipientStrategy,
} from "@/lib/notifications/policy";
import type { SystemNotificationChannel, SystemNotificationPriority } from "@/lib/notifications/system";

export type NotificationTypeDelivery = "direct_email" | "both";

export type NotificationTypeEntry = {
  delivery?: NotificationTypeDelivery;
  eventType: string;
  label: string;
  module: string;
  sentFrom: readonly string[];
};

const ATTENDANCE_DIGEST = "src/lib/attendance/digest-notify.ts";
const AUTOMATED_PAYROLL = "src/lib/automated-payroll/notify.ts";
const DIRECT_ORDERS = "src/lib/direct-orders/service.ts";
const DISPUTE_CENTER = "src/lib/dispute-center/notify.ts";
const EXCUSES = "src/lib/excuses/service.ts";
const HR_OPS_REPORTS = "src/lib/hr-ops-reports/notify.ts";
const MARKET_AWARENESS = "src/lib/market-awareness/notifications.ts";
const MARKETING_FUNCTIONS = "src/lib/marketing-functions/notify.ts";
const MARKETING_REQUESTS = "src/lib/marketing-requests/service.ts";
const OFFERS_ACCEPTED = "src/lib/offers/accepted-offer-alert.ts";
const OFFERS_APPROVAL = "src/lib/offers/approval.ts";
const OFFERS_SEND = "src/lib/offers/send.ts";
const OUTSTATION = "src/lib/outstation/service.ts";
const PASSWORD_SETUP = "src/lib/auth/password-setup.ts";
const PHOENIX_CRM = "src/lib/phoenix-crm/server/notifications.ts";
const RECRUITMENT_INBOUND = "src/lib/recruitment/inbound/recruitment-notify.ts";
const VACATION = "src/lib/vacation/service.ts";
const VACATION_EMAIL = "src/lib/vacation/email.ts";
const WEEKLY_PLANS = "src/lib/weekly-planning/service.ts";

export const NOTIFICATION_TYPES: readonly NotificationTypeEntry[] = [
  // ── Attendance ──────────────────────────────────────────────────────────────────────────────
  { module: "attendance", eventType: "attendance_agent_ingestion_stalled", label: "The attendance machines have stopped sending punches", sentFrom: ["src/lib/attendance/ingestion-health.ts"] },
  { module: "attendance_digest", eventType: "week_released", label: "Your attendance week has been released for review", sentFrom: [ATTENDANCE_DIGEST] },
  { module: "attendance_digest", eventType: "dispute_filed", label: "An employee disputed a day of their attendance week", sentFrom: [ATTENDANCE_DIGEST] },
  { module: "attendance_digest", eventType: "dispute_decided", label: "Your attendance dispute has been decided", sentFrom: [ATTENDANCE_DIGEST] },
  // The Dispute Center names each notice `dispute_center_<step>`, the step being the first part of
  // the caller's event key, and files it under the module its kind belongs to (calendar →
  // private_calendar, deduction and daily → deductions, digest → attendance_digest). Every step each
  // kind's own file raises is listed: src/lib/dispute-center/{calendar,daily,deduction,digest}.ts.
  { module: "attendance_digest", eventType: "dispute_center_message", label: "A new message on an attendance dispute", sentFrom: [DISPUTE_CENTER] },
  { module: "attendance_digest", eventType: "dispute_center_decided", label: "An attendance dispute has been decided", sentFrom: [DISPUTE_CENTER] },
  { module: "attendance_digest", eventType: "dispute_center_reopen_requested", label: "An employee asked to reopen a decided attendance dispute", sentFrom: [DISPUTE_CENTER] },
  { module: "attendance_digest", eventType: "dispute_center_reopened", label: "Your attendance dispute has been reopened", sentFrom: [DISPUTE_CENTER] },
  { module: "attendance_digest", eventType: "dispute_center_reopen_declined", label: "Your request to reopen an attendance dispute was declined", sentFrom: [DISPUTE_CENTER] },

  // ── Birthdays, holidays, coaching, cards, support ───────────────────────────────────────────
  { module: "birthday", eventType: "birthday_today", label: "Happy birthday", sentFrom: ["app/api/notifications/birthdays/route.ts"] },
  { module: "holiday_confirmation", eventType: "holiday_confirmation_reminder", label: "Confirm the date of a coming national holiday", sentFrom: ["app/api/notifications/holiday-confirmation/route.ts"] },
  { module: "coaching", eventType: "report_submitted", label: "A new coaching report was submitted", sentFrom: ["app/api/coaching/reports/[id]/submit/route.ts"] },
  { module: "business_card_requests", eventType: "business_card_request_created", label: "A new business card request", sentFrom: ["src/lib/business-cards/request-service.ts"] },
  { module: "support_requests", eventType: "support_request_created", label: "A new support request", sentFrom: ["src/lib/support-requests/service.ts"] },

  // ── Contracts, probation, resignations ──────────────────────────────────────────────────────
  { module: "contract_renewal", eventType: "renewal_reminder", label: "An employee's contract is due for renewal", sentFrom: ["app/api/notifications/contract-renewals/route.ts"] },
  { module: "contract_renewal", eventType: "workflow_updated", label: "A contract renewal moved to its next step", sentFrom: ["src/lib/contracts/service.ts"] },
  { module: "probation", eventType: "reminder_due", label: "A probation review is due for your team member", sentFrom: ["src/lib/probation/service.ts"] },
  { module: "probation", eventType: "workflow_updated", label: "A probation review moved to its next step", sentFrom: ["src/lib/probation/service.ts"] },
  // `milestone_day${m.day}` over PROBATION_MILESTONES — days 30, 60 and 75.
  { module: "probation", eventType: "milestone_day30", label: "A new hire reached Day 30 of probation", sentFrom: ["src/lib/probation/intelligence/milestone-emails.ts"] },
  { module: "probation", eventType: "milestone_day60", label: "A new hire reached Day 60 of probation", sentFrom: ["src/lib/probation/intelligence/milestone-emails.ts"] },
  { module: "probation", eventType: "milestone_day75", label: "A new hire reached Day 75 of probation", sentFrom: ["src/lib/probation/intelligence/milestone-emails.ts"] },
  { module: "resignations", eventType: "workflow_updated", label: "A resignation moved to its next step", sentFrom: ["src/lib/resignations/service.ts"] },
  // Sent under the singular `resignation`, so the `resignations.*` policy row does not reach it.
  { module: "resignation", eventType: "resignation_sla_reminder", label: "A resignation is waiting too long for a decision", sentFrom: ["src/lib/resignations/service.ts"] },

  // ── Deductions ──────────────────────────────────────────────────────────────────────────────
  { module: "deductions", eventType: "deduction_pushed", label: "A payroll deduction was recorded against you", sentFrom: ["src/lib/deductions/notify-deduction.ts"] },
  { module: "deductions", eventType: "deduction_pushed_cc", label: "A payroll deduction was recorded for your team member", sentFrom: ["src/lib/deductions/notify-deduction.ts"] },
  { module: "deductions", eventType: "deductions_comment", label: "A new comment on a deduction", sentFrom: ["src/lib/deductions/comments.ts"] },
  { module: "deductions", eventType: "dispute_center_opened", label: "An employee disputed a daily deduction", sentFrom: [DISPUTE_CENTER] },
  { module: "deductions", eventType: "dispute_center_message", label: "A new message on a deduction dispute", sentFrom: [DISPUTE_CENTER] },
  { module: "deductions", eventType: "dispute_center_decided", label: "A deduction dispute has been decided", sentFrom: [DISPUTE_CENTER] },
  { module: "deductions", eventType: "dispute_center_reopen_requested", label: "An employee asked to reopen a decided deduction dispute", sentFrom: [DISPUTE_CENTER] },
  { module: "deductions", eventType: "dispute_center_reopened", label: "Your deduction dispute has been reopened", sentFrom: [DISPUTE_CENTER] },
  { module: "deductions", eventType: "dispute_center_reopen_declined", label: "Your request to reopen a deduction dispute was declined", sentFrom: [DISPUTE_CENTER] },

  // ── Direct orders ───────────────────────────────────────────────────────────────────────────
  { module: "direct_orders", eventType: "submitted", label: "A direct order is waiting for your approval", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "resubmitted", label: "A corrected direct order is back for your approval", sentFrom: [DIRECT_ORDERS] },
  // The decision itself is the event: DirectOrderDecision — approve, reject, return.
  { module: "direct_orders", eventType: "approve", label: "A direct order was approved", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "reject", label: "A direct order was rejected", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "return", label: "A direct order was sent back for changes", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "held_notice_sent", label: "A direct order is held until its pharmacy is validated", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "released", label: "A held direct order was released into approval", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "revived", label: "A held direct order came back into approval", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "expired", label: "A held direct order expired because its pharmacy was never validated", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "cancelled", label: "A direct order was cancelled", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "reversal_submitted", label: "A direct order reversal is waiting for your approval", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "approval_rung_repaired", label: "A direct order is now waiting on you after its approver changed", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "direct_order_comment", label: "A new comment on a direct order", sentFrom: [DIRECT_ORDERS] },
  { module: "direct_orders", eventType: "direct_order_approved", label: "A direct order received its final approval", sentFrom: ["src/lib/direct-orders/approved-email.ts"], delivery: "direct_email" },
  { module: "direct_orders", eventType: "direct_order_phantom_report", label: "Pharmacies that failed their direct-order probation", sentFrom: ["src/lib/direct-orders/phantom-report.ts"], delivery: "direct_email" },

  // ── Early Birds, employee import ────────────────────────────────────────────────────────────
  { module: "early_birds", eventType: "recommendation_pending", label: "An Early Bird recommendation is waiting for your decision", sentFrom: ["src/lib/early-birds/notify.ts"] },
  { module: "employee_import", eventType: "employee_import_completed", label: "An employee import has finished", sentFrom: ["app/api/imports/employees/confirm/route.ts"] },

  // ── Excuses ─────────────────────────────────────────────────────────────────────────────────
  { module: "excuse", eventType: "request_submitted", label: "An excuse request is waiting for your approval", sentFrom: [EXCUSES] },
  { module: "excuse", eventType: "request_resubmitted", label: "A corrected excuse request is back for your approval", sentFrom: [EXCUSES] },
  { module: "excuse", eventType: "request_decided", label: "An excuse request has been decided", sentFrom: [EXCUSES] },
  { module: "excuse", eventType: "excuse_sla_reminder", label: "An excuse request is waiting too long for approval", sentFrom: [EXCUSES] },
  { module: "excuse", eventType: "drift_alert", label: "Excuse requests whose records and approvals disagree", sentFrom: ["src/lib/excuses/drift-check.ts"] },

  // ── HR operations ───────────────────────────────────────────────────────────────────────────
  { module: "hr_ops_reports", eventType: "hr_ops_reports.report_ready", label: "An HR daily or weekly report is ready for your review", sentFrom: [HR_OPS_REPORTS] },
  { module: "hr_ops_reports", eventType: "hr_ops_reports.report_submitted", label: "An HR daily or weekly report is waiting for your decision", sentFrom: [HR_OPS_REPORTS] },
  { module: "hr_ops_reports", eventType: "hr_ops_reports.report_decided", label: "An HR report you reviewed has been decided", sentFrom: [HR_OPS_REPORTS] },
  { module: "hr_reminders", eventType: "hr_reminders.comment", label: "A teammate commented on an HR reminder", sentFrom: ["src/lib/hr-reminders/notify.ts"] },
  { module: "internal_messages", eventType: "internal_message_sent", label: "You received an internal message", sentFrom: ["src/lib/internal-messages/service.ts"] },
  { module: "internal_messages", eventType: "internal_message_email_requested", label: "An internal message was also sent to you by email", sentFrom: ["src/lib/internal-messages/service.ts"] },
  { module: "mailbox_offboarding", eventType: "mailbox_offboarding_overdue", label: "A leaver's mailbox has not been closed in time", sentFrom: ["src/lib/mailbox-offboarding/sweep.ts"] },
  { module: "new_hire_mailbox", eventType: "employee_added", label: "A new hire needs a company mailbox", sentFrom: ["src/lib/new-hire-mailbox/notify.ts"] },
  { module: "needs_you", eventType: "needs_you_daily_digest", label: "Your daily list of decisions waiting on you", sentFrom: ["src/lib/needs-you/deliver/daily.ts"] },
  { module: "needs_you", eventType: "needs_you_weekly_digest", label: "Your weekly list of decisions waiting on you", sentFrom: ["src/lib/needs-you/deliver/weekly.ts"] },
  { module: "retention_risk", eventType: "retention_risk_flagged", label: "A colleague may be at risk of leaving", sentFrom: ["src/lib/retention-risk/notify.ts"] },
  { module: "retention_risk", eventType: "retention_risk_pre_payroll", label: "Colleagues at risk of leaving, before payroll closes", sentFrom: ["src/lib/retention-risk/notify.ts"] },

  // ── Leave ───────────────────────────────────────────────────────────────────────────────────
  { module: "vacation", eventType: "request_submitted", label: "A leave request is waiting for your approval", sentFrom: [VACATION] },
  { module: "vacation", eventType: "request_submitted_informed", label: "A colleague requested leave (for your information)", sentFrom: [VACATION] },
  { module: "vacation", eventType: "next_manager_review", label: "A leave request needs your approval at the next step", sentFrom: [VACATION] },
  { module: "vacation", eventType: "employee_step_approved", label: "A leave request approved at one step needs your approval", sentFrom: [VACATION] },
  // `manager_review:${decision}` and `decision:${decision}` — the return branch never reaches either, so approve and reject only.
  { module: "vacation", eventType: "manager_review:approve", label: "A manager approved a leave request", sentFrom: [VACATION] },
  { module: "vacation", eventType: "manager_review:reject", label: "A manager rejected a leave request", sentFrom: [VACATION] },
  { module: "vacation", eventType: "decision:approve", label: "A leave request was approved", sentFrom: [VACATION] },
  { module: "vacation", eventType: "decision:reject", label: "A leave request was rejected", sentFrom: [VACATION] },
  { module: "vacation", eventType: "return", label: "Your leave request was sent back for changes", sentFrom: [VACATION] },
  { module: "vacation", eventType: "return_hr_notice", label: "A leave request was sent back to the employee", sentFrom: [VACATION] },
  { module: "vacation", eventType: "resubmit", label: "A corrected leave request is back for your approval", sentFrom: [VACATION] },
  { module: "vacation", eventType: "employee_resubmit_confirm", label: "Your corrected leave request was resubmitted", sentFrom: [VACATION] },
  { module: "vacation", eventType: "admin_override", label: "A leave approval passed to the System Administrator", sentFrom: [VACATION] },
  // `sla:${slaStatus.stage}` for an overdue request — the manager stage or the HR stage.
  { module: "vacation", eventType: "sla:manager", label: "A leave request is overdue for the manager's decision", sentFrom: [VACATION] },
  { module: "vacation", eventType: "sla:hr", label: "A leave request is overdue for HR's decision", sentFrom: [VACATION] },
  { module: "vacation", eventType: "vacation_manager_decision", label: "A leave request is waiting for your decision (email)", sentFrom: [VACATION_EMAIL], delivery: "direct_email" },
  { module: "vacation", eventType: "vacation_manager_step_result", label: "A manager decided a leave request (email)", sentFrom: [VACATION_EMAIL], delivery: "direct_email" },
  { module: "vacation", eventType: "vacation_decision_result", label: "Your leave request was approved or rejected (email)", sentFrom: [VACATION_EMAIL], delivery: "direct_email" },
  { module: "vacation", eventType: "vacation_returned", label: "Your leave request was sent back for changes (email)", sentFrom: [VACATION_EMAIL], delivery: "direct_email" },
  { module: "vacation", eventType: "vacation_balance_settlement", label: "A leave balance settlement (email)", sentFrom: [VACATION_EMAIL], delivery: "direct_email" },

  // ── Market Awareness ────────────────────────────────────────────────────────────────────────
  { module: "market_awareness", eventType: "market_awareness_decision_pending", label: "A Market Awareness activity is waiting for your decision", sentFrom: [MARKET_AWARENESS] },
  { module: "market_awareness", eventType: "market_awareness_activity_approved", label: "Your Market Awareness activity was approved", sentFrom: [MARKET_AWARENESS] },
  { module: "market_awareness", eventType: "market_awareness_activity_rejected", label: "Your Market Awareness activity was not approved", sentFrom: [MARKET_AWARENESS] },
  { module: "market_awareness", eventType: "market_awareness_activity_returned", label: "Your Market Awareness activity was sent back for changes", sentFrom: [MARKET_AWARENESS] },
  { module: "market_awareness", eventType: "market_awareness_activity_held", label: "Your Market Awareness activity is on hold", sentFrom: [MARKET_AWARENESS] },
  { module: "market_awareness", eventType: "market_awareness_comment", label: "A new comment on a Market Awareness activity", sentFrom: ["src/lib/market-awareness/service.ts"] },

  // ── Marketing ───────────────────────────────────────────────────────────────────────────────
  { module: "marketing_functions", eventType: "marketing_functions.month_submitted", label: "A monthly Marketing Functions sheet is waiting for your review", sentFrom: [MARKETING_FUNCTIONS] },
  { module: "marketing_functions", eventType: "marketing_functions.month_reviewed", label: "Your monthly Marketing Functions sheet was reviewed", sentFrom: [MARKETING_FUNCTIONS] },
  { module: "marketing_functions", eventType: "marketing_functions.month_reopened", label: "Your monthly Marketing Functions sheet was reopened", sentFrom: [MARKETING_FUNCTIONS] },
  { module: "marketing_requests", eventType: "request_submitted", label: "Your marketing request was submitted", sentFrom: [MARKETING_REQUESTS] },
  { module: "marketing_requests", eventType: "request_assigned", label: "A marketing request is waiting for your approval", sentFrom: [MARKETING_REQUESTS] },
  { module: "marketing_requests", eventType: "request_approved", label: "A marketing request was approved", sentFrom: [MARKETING_REQUESTS] },
  { module: "marketing_requests", eventType: "request_rejected", label: "Your marketing request was rejected", sentFrom: [MARKETING_REQUESTS] },
  { module: "marketing_requests", eventType: "request_returned", label: "Your marketing request was sent back for changes", sentFrom: [MARKETING_REQUESTS] },
  // The daily SLA pass sends the more urgent of the two for each request (mostUrgentMarketingSla).
  { module: "marketing_requests", eventType: "due_date_reminder", label: "A marketing request is close to its due date without a decision", sentFrom: [MARKETING_REQUESTS] },
  { module: "marketing_requests", eventType: "overdue_reminder", label: "A marketing request is overdue for a decision", sentFrom: [MARKETING_REQUESTS] },
  { module: "marketing_requests", eventType: "marketing_request_comment", label: "A new comment on a marketing request", sentFrom: [MARKETING_REQUESTS] },
  { module: "marketing_requests", eventType: "invoice_overdue", label: "A marketing invoice is past its deadline", sentFrom: ["src/lib/marketing-requests/invoice-overdue-nudge.ts"] },
  { module: "marketing_requests", eventType: "field_capture_backlog", label: "Marketing customers still need proof from the field", sentFrom: ["src/lib/marketing-requests/field-capture-backlog.ts"] },
  { module: "marketing_requests", eventType: "approved_requests_sent", label: "The list of approved marketing requests", sentFrom: ["src/lib/marketing-requests/ceo-approvals-email-service.ts"], delivery: "both" },

  // ── Job offers ──────────────────────────────────────────────────────────────────────────────
  { module: "offers", eventType: "offer_approval_requested", label: "A job offer is waiting for your approval", sentFrom: [OFFERS_APPROVAL] },
  { module: "offers", eventType: "offer_approval_approved", label: "A job offer was approved", sentFrom: [OFFERS_APPROVAL] },
  { module: "offers", eventType: "offer_approval_returned", label: "A job offer was sent back for changes", sentFrom: [OFFERS_APPROVAL] },
  { module: "offers", eventType: "offer_accepted", label: "A candidate accepted a job offer", sentFrom: [OFFERS_ACCEPTED] },
  { module: "offers", eventType: "offer_accepted_team", label: "A new colleague is joining your team", sentFrom: [OFFERS_ACCEPTED] },
  { module: "offers", eventType: "offer_joining_form_blocked", label: "A new hire's joining form needs HR", sentFrom: [OFFERS_ACCEPTED] },
  { module: "offers", eventType: "offer_letter", label: "Your job offer letter (to the candidate)", sentFrom: [OFFERS_SEND], delivery: "direct_email" },
  { module: "offers", eventType: "offer_expired", label: "Your job offer has expired (to the candidate)", sentFrom: [OFFERS_SEND], delivery: "direct_email" },

  // ── Outstation ──────────────────────────────────────────────────────────────────────────────
  { module: "outstation", eventType: "request_submitted", label: "An outstation request is waiting for your approval", sentFrom: [OUTSTATION] },
  { module: "outstation", eventType: "request_rejected", label: "Your outstation request was rejected", sentFrom: [OUTSTATION] },
  { module: "outstation", eventType: "outstation_departure_photo_due", label: "Take your outstation departure photo", sentFrom: [OUTSTATION] },
  { module: "outstation", eventType: "outstation_sla_reminder", label: "An outstation request is waiting too long for approval", sentFrom: [OUTSTATION] },

  // ── Accounts and sign-in ────────────────────────────────────────────────────────────────────
  // The module and the event follow the same `purpose === "setup"` choice, so they pair up.
  { module: "password_setup", eventType: "password_setup_link_created", label: "Your link to set up your account", sentFrom: [PASSWORD_SETUP] },
  { module: "password_setup", eventType: "account_credentials_sent", label: "Your new account's sign-in details", sentFrom: [PASSWORD_SETUP] },
  { module: "password_reset", eventType: "password_reset_link_created", label: "Your link to reset your password", sentFrom: [PASSWORD_SETUP] },
  { module: "password_reset", eventType: "temporary_password_sent", label: "Your temporary password", sentFrom: [PASSWORD_SETUP] },
  { module: "password_reset", eventType: "password_reset_code_created", label: "Your password reset code", sentFrom: [PASSWORD_SETUP] },
  { module: "telegram", eventType: "telegram_onboarding_link", label: "Connect Telegram to your Phoenix notifications", sentFrom: ["src/lib/notifications/telegram-onboarding.ts"], delivery: "direct_email" },

  // ── Payroll ─────────────────────────────────────────────────────────────────────────────────
  { module: "payroll", eventType: "payslip_available", label: "Your payslip is available", sentFrom: ["src/lib/payroll/notify-payslip-available.ts"] },
  { module: "payroll", eventType: "salary_upload_imported", label: "A payroll file was imported", sentFrom: ["app/api/payroll/upload/route.ts"] },
  { module: "payroll", eventType: "workflow_updated", label: "A payroll run moved to its next step", sentFrom: ["app/api/payroll/[id]/workflow/route.ts"] },
  { module: "payroll", eventType: "automated_payroll_part1_ready", label: "Payroll Part 1 is ready for finance", sentFrom: [AUTOMATED_PAYROLL] },
  { module: "payroll", eventType: "automated_payroll_part1_submitted_review", label: "Payroll Part 1 was submitted for your review", sentFrom: [AUTOMATED_PAYROLL] },
  { module: "payroll", eventType: "automated_payroll_part2_ready", label: "Payroll Part 2 is ready for finance", sentFrom: [AUTOMATED_PAYROLL] },
  { module: "payroll", eventType: "automated_payroll_published", label: "The month's payroll was published", sentFrom: [AUTOMATED_PAYROLL] },

  // ── Phoenix CRM ─────────────────────────────────────────────────────────────────────────────
  { module: "phoenix_crm", eventType: "plan_waiting", label: "A rep's weekly plan is waiting for your review", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "plan_approved", label: "Your weekly plan was approved", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "plan_returned", label: "Your weekly plan was sent back for changes", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "plan_resent", label: "A weekly plan you returned was sent again", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "plan_reminder", label: "Send your weekly plan", sentFrom: ["src/lib/phoenix-crm/server/plan-reminder.ts"] },
  { module: "phoenix_crm", eventType: "plan_edit_waiting", label: "A rep asked to edit a weekly plan already sent", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "plan_edit_moved_on", label: "An ask to edit a weekly plan moved to its next step", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "plan_edit_reopened", label: "Your weekly plan is open to edit", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "plan_edit_refused", label: "Your ask to edit a weekly plan was refused", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "plan_edit_expired", label: "Your ask to edit a weekly plan ended with its week", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "monthly_plan_waiting", label: "A rep's monthly plan is waiting for your review", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "monthly_plan_approved", label: "Your monthly plan was approved", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "monthly_plan_returned", label: "Your monthly plan was sent back for changes", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "forecast_sent", label: "A rep sent the daily forecast", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "grade_request_waiting", label: "A rep asked to change a customer's grade", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "drop_request_waiting", label: "A rep asked to drop a customer from the list", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "add_request_waiting", label: "A rep asked to add a customer to the list", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "restore_request_waiting", label: "A rep asked to bring a customer back to the list", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "request_approved", label: "Your customer list request was approved", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "request_refused", label: "Your customer list request was refused", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "request_returned", label: "A comment is needed on your customer list request", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "request_answered", label: "A comment was received on a customer list request", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "unplanned_visit_waiting", label: "An off-plan visit is waiting for your approval", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "unplanned_visit_approved", label: "Your off-plan visit was approved", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "unplanned_visit_refused", label: "Your off-plan visit was refused", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "unplanned_visit_moved_on", label: "An off-plan visit moved to its next approver", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "recorded_visit_decided", label: "A recorded visit was approved or not approved", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "first_visit_submitted", label: "A rep submitted a first Phoenix CRM visit", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "day_start_confirmed", label: "A rep started the working day", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "day_start_seen", label: "A rep started the working day (copy for SFE)", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "team_not_started", label: "Reps on your team have not started the day", sentFrom: ["src/lib/crm/phoenix-team-start-notice.ts"] },
  { module: "phoenix_crm", eventType: "visit_ask_waiting", label: "A visit was asked of you", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "visit_ask_told", label: "A visit you asked for was passed to the rep", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "visit_ask_accepted", label: "A visit you asked for was accepted", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "visit_ask_declined", label: "A visit you asked for was declined", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "double_visit_waiting", label: "A rep asked you for a double visit", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "double_visit_days_changed", label: "The days of a double visit were changed", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "double_visit_accepted", label: "Your double visit was accepted", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "double_visit_declined", label: "Your double visit was declined", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "validation_not_confirmed", label: "A customer's place could not be confirmed from your photo", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "validation_review_waiting", label: "A customer's place is waiting for your check", sentFrom: ["src/lib/phoenix-crm/server/validation-reviews.ts"] },
  { module: "phoenix_crm", eventType: "manager_plan_waiting", label: "A district manager's weekly plan is waiting for your approval", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_plan_approved", label: "Your weekly plan as a manager was approved", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_plan_returned", label: "Your weekly plan as a manager was sent back", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_plan_edit_waiting", label: "A district manager asked to edit a weekly plan", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_plan_edit_reopened", label: "Your manager weekly plan is open to edit", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_plan_edit_refused", label: "Your ask to edit a manager weekly plan was refused", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_plan_edit_expired", label: "Your ask to edit a manager weekly plan ended with its week", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_plan_with_you", label: "A district manager planned a day with you", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_plan_conversation", label: "A new message on a manager's weekly plan", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_list_removal_waiting", label: "A manager asked to take a customer off their own list", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_list_removal_decided", label: "Your ask to take a customer off your own list was decided", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_single_visit_day_waiting", label: "A manager asked for another day of single visits", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_single_visit_day_decided", label: "Your ask for another day of single visits was decided", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "manager_single_visit_day_expired", label: "Your ask for another day of single visits ended with its week", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "activity_mirror", label: "A Phoenix CRM action by a rep (activity copy)", sentFrom: [PHOENIX_CRM] },
  { module: "phoenix_crm", eventType: "crm_visit_rollup", label: "The hourly roundup of routine planned visits", sentFrom: ["src/lib/phoenix-crm/server/visit-rollup.ts"] },
  { module: "phoenix_crm", eventType: "crm_daily_digest", label: "The morning Phoenix CRM digest", sentFrom: ["src/lib/phoenix-crm/server/daily-digest.ts"] },
  { module: "phoenix_crm", eventType: "approval_nudge", label: "Phoenix CRM items are waiting for your approval", sentFrom: ["src/lib/phoenix-crm/server/approval-nudge.ts"] },
  { module: "phoenix_crm", eventType: "far_visit_stuck", label: "A rep has been stuck at one spot", sentFrom: ["src/lib/phoenix-crm/server/far-visit-safeguards.ts"] },
  { module: "phoenix_crm", eventType: "crm_fraud_scan", label: "Visits the integrity scan flagged", sentFrom: ["src/lib/phoenix-crm/server/fraud-scan.ts"] },

  // ── Private calendar ────────────────────────────────────────────────────────────────────────
  { module: "private_calendar", eventType: "private_calendar_dispute_submitted", label: "An employee disputed their private calendar data", sentFrom: ["src/lib/private-calendar/disputes.ts"] },
  { module: "private_calendar", eventType: "private_calendar_dispute_decided", label: "Your private calendar dispute has been decided", sentFrom: ["src/lib/private-calendar/disputes.ts"] },
  { module: "private_calendar", eventType: "private_calendar_dispute_message", label: "A new message on a private calendar dispute", sentFrom: ["src/lib/private-calendar/dispute-messages.ts"] },
  { module: "private_calendar", eventType: "private_calendar_gap_notice", label: "Days are missing from your private calendar", sentFrom: ["src/lib/private-calendar/gap-notice.ts"] },
  { module: "private_calendar", eventType: "dispute_center_reopen_requested", label: "An employee asked to reopen a decided calendar dispute", sentFrom: [DISPUTE_CENTER] },
  { module: "private_calendar", eventType: "dispute_center_reopened", label: "Your calendar dispute has been reopened", sentFrom: [DISPUTE_CENTER] },
  { module: "private_calendar", eventType: "dispute_center_reopen_declined", label: "Your request to reopen a calendar dispute was declined", sentFrom: [DISPUTE_CENTER] },

  // ── Production planning ─────────────────────────────────────────────────────────────────────
  { module: "production_planning", eventType: "production_expiry_alarm", label: "Production materials close to expiry", sentFrom: ["src/lib/production-planning/expiry-sweep.ts"], delivery: "direct_email" },
  { module: "production_planning", eventType: "production_reorder_alarm", label: "Production materials to reorder", sentFrom: ["src/lib/production-planning/reorder-sweep.ts"], delivery: "direct_email" },

  // ── Recruitment ─────────────────────────────────────────────────────────────────────────────
  { module: "recruitment", eventType: "recruitment_inbound_cv", label: "A new CV was received", sentFrom: [RECRUITMENT_INBOUND] },
  { module: "recruitment", eventType: "recruitment_daily_cv_digest", label: "The day's new CVs", sentFrom: [RECRUITMENT_INBOUND] },
  { module: "recruitment", eventType: "recruitment_cv_intake_digest_6h", label: "The CVs received in the last six hours", sentFrom: ["src/lib/recruitment/inbound/cv-intake-digest-6h.ts"], delivery: "direct_email" },
  { module: "recruitment", eventType: "recruitment_inbound_intake_dead_letter", label: "An incoming CV needs manual review", sentFrom: [RECRUITMENT_INBOUND] },
  { module: "recruitment", eventType: "recruitment_inbound_intake_spike", label: "Incoming CVs are failing more than usual", sentFrom: [RECRUITMENT_INBOUND] },
  { module: "recruitment", eventType: "recruitment_whatsapp_intake_unhealthy", label: "The WhatsApp CV line is not receiving", sentFrom: [RECRUITMENT_INBOUND] },
  { module: "recruitment", eventType: "recruitment_whatsapp_text_only", label: "A WhatsApp applicant sent text but no CV", sentFrom: [RECRUITMENT_INBOUND] },
  { module: "recruitment", eventType: "recruitment_whatsapp_unreadable_cv", label: "A WhatsApp CV could not be read", sentFrom: [RECRUITMENT_INBOUND] },
  { module: "recruitment", eventType: "whatsapp_handset_echoes_off", label: "The WhatsApp handset stopped copying messages", sentFrom: ["src/lib/recruitment/inbound/whatsapp-handset-reminder.ts"] },
  { module: "recruitment", eventType: "whatsapp_handset_open_reminder", label: "Open the WhatsApp handset to keep it connected", sentFrom: ["src/lib/recruitment/inbound/whatsapp-handset-reminder.ts"] },
  { module: "recruitment", eventType: "candidate_assigned", label: "A candidate was sent to you to review", sentFrom: ["src/lib/recruitment/hiring-manager-notify.ts", "src/lib/recruitment/manager-cv-reminders.ts"] },
  { module: "recruitment", eventType: "candidate_comment", label: "A new comment on a candidate", sentFrom: ["src/lib/recruitment/candidate-comments.ts"] },
  { module: "recruitment", eventType: "recruitment_manager_hold_returned", label: "Candidates held too long were returned to HR", sentFrom: ["src/lib/recruitment/manager-hold-return.ts"] },
  { module: "recruitment", eventType: "recruitment_stale_send_nudge", label: "Candidates you were sent are still waiting", sentFrom: ["src/lib/recruitment/stale-send-check.ts"] },
  { module: "recruitment", eventType: "recruitment_stale_send_stranded", label: "Candidates are stranded with a manager", sentFrom: ["src/lib/recruitment/stale-send-check.ts"] },
  { module: "recruitment", eventType: "recruitment_triage_backlog", label: "CVs are waiting too long for triage", sentFrom: ["src/lib/recruitment/triage-backlog-check.ts"] },
  { module: "recruitment", eventType: "interview_request_created", label: "A new interview request", sentFrom: ["src/lib/recruitment/interview-request-notifications.ts"] },
  { module: "recruitment", eventType: "interview_request_scheduled", label: "An interview was booked", sentFrom: ["src/lib/recruitment/interview-request-notifications.ts"] },
  { module: "recruitment", eventType: "interview_assigned", label: "A new interview for you to conduct", sentFrom: ["src/lib/recruitment/interview-request-notifications.ts"] },
  { module: "recruitment", eventType: "interview_email", label: "An interview was scheduled, changed or cancelled (email)", sentFrom: ["src/lib/recruitment/interview-notifications.ts"] },
  { module: "recruitment", eventType: "interview_notification", label: "An interview was scheduled, changed or cancelled", sentFrom: ["src/lib/recruitment/interview-notifications.ts"] },
  { module: "recruitment", eventType: "interview_reminder", label: "Interview reminder", sentFrom: ["src/lib/recruitment/notifications.ts"] },
  // The reminder's kind picks one of three (interview-reminders.ts).
  { module: "recruitment", eventType: "interview_reminder_hour", label: "Your interview starts within the hour", sentFrom: ["src/lib/recruitment/interview-reminders.ts"] },
  { module: "recruitment", eventType: "interview_reminder_evening", label: "You have an interview tomorrow", sentFrom: ["src/lib/recruitment/interview-reminders.ts"] },
  { module: "recruitment", eventType: "interview_awaiting_response", label: "An interview is still waiting for the candidate's answer", sentFrom: ["src/lib/recruitment/interview-reminders.ts"] },
  { module: "recruitment", eventType: "interview_calendar_shared", label: "An interview was shared with you", sentFrom: ["src/lib/recruitment/interview-calendar.ts"] },
  { module: "recruitment", eventType: "recruitment_interview_declined", label: "An interview was declined", sentFrom: ["src/lib/recruitment/interview-calendar.ts"] },
  { module: "recruitment", eventType: "mr_interview_booked", label: "A medical rep interview was booked or moved", sentFrom: ["src/lib/recruitment/mr-hiring/notify.ts"] },
  { module: "recruitment", eventType: "mr_recommendation_ready", label: "A final hiring decision is needed for a medical rep candidate", sentFrom: ["src/lib/recruitment/mr-hiring/notify.ts"] },
  { module: "recruitment", eventType: "mr_candidate_for_your_area", label: "HR passed a medical rep candidate for your area", sentFrom: ["src/lib/recruitment/mr-hiring/notify.ts"] },
  { module: "recruitment.website-apply", eventType: "careers_application_confirmation", label: "We received your application (to the applicant)", sentFrom: ["src/lib/recruitment/inbound/website-apply-confirmation-email.ts"], delivery: "direct_email" },

  // ── Sales ───────────────────────────────────────────────────────────────────────────────────
  { module: "sales", eventType: "closing_published", label: "A monthly closing was published", sentFrom: ["src/lib/sales/closing-publish-notification.ts"], delivery: "both" },
  { module: "sales", eventType: "distributor_upload_overdue", label: "A distributor's sales file is late", sentFrom: ["src/lib/sales/distributor-upload-nudge.ts"] },
  { module: "sales", eventType: "weekly_sales_uploaded", label: "This week's sales were uploaded", sentFrom: ["src/lib/sales/weekly/upload-notification.ts"], delivery: "direct_email" },
  { module: "sales", eventType: "targets_uploaded", label: "New sales targets were uploaded", sentFrom: ["src/lib/sales/targets-uploaded-notification.ts"], delivery: "direct_email" },
  { module: "sales", eventType: "sos_monthly_closing_report", label: "The monthly closing report", sentFrom: ["src/lib/sales/sos-report-delivery.ts"], delivery: "direct_email" },

  // ── System and operations ───────────────────────────────────────────────────────────────────
  { module: "system", eventType: "daily_hr_digest", label: "The daily HR digest", sentFrom: ["src/lib/notifications/telegram-operations.ts"] },
  { module: "system", eventType: "system_audit_daily", label: "The day's system health findings", sentFrom: ["src/lib/system-audit/daily-message.ts"] },
  // `background_jobs_run_${status}` — the weekly run either succeeded or failed.
  { module: "system", eventType: "background_jobs_run_success", label: "The weekly background jobs run finished", sentFrom: ["src/lib/notifications/background-jobs-digest.ts"] },
  { module: "system", eventType: "background_jobs_run_failed", label: "The weekly background jobs run failed", sentFrom: ["src/lib/notifications/background-jobs-digest.ts"] },
  // `database_host_${kind}` over DbHostAlarmKind.
  { module: "system", eventType: "database_host_low_memory", label: "The database server is low on memory", sentFrom: ["src/lib/observability/db-host-alert.ts"] },
  { module: "system", eventType: "database_host_low_root_disk", label: "The database server is low on disk space", sentFrom: ["src/lib/observability/db-host-alert.ts"] },
  { module: "system", eventType: "database_restarted", label: "The database restarted", sentFrom: ["src/lib/observability/database-restart-alert.ts"] },
  { module: "system", eventType: "github_workflow_overdue", label: "A scheduled build job has not run on time", sentFrom: ["src/lib/observability/github-workflow-watch-alert.ts"] },
  { module: "system", eventType: "scheduled_job_stranded", label: "A scheduled job has stopped running", sentFrom: ["src/lib/observability/job-heartbeat-alert.ts"] },
  { module: "system", eventType: "notification_drain_stranded", label: "Notifications are stuck in the send queue", sentFrom: ["src/lib/notifications/drain-health-alert.ts"] },
  { module: "system", eventType: "notification_held_for_review", label: "An automated email is held for your review", sentFrom: ["src/lib/notifications/held-notification-alert.ts"] },
  { module: "system", eventType: "notification_holds_expired", label: "Held emails were discarded at their deadline", sentFrom: ["src/lib/notifications/held-notification-alert.ts"] },
  { module: "system", eventType: "dead_telegram_link_alert", label: "Telegram messages were thrown away because a link is dead", sentFrom: ["src/lib/notifications/dead-telegram-link-alert.ts"] },
  { module: "system", eventType: "email_block_new", label: "A new address was blocked from receiving email", sentFrom: ["src/lib/email/suppression-watch.ts"] },
  { module: "system", eventType: "ai_quota_exhausted", label: "The AI service has run out of credit", sentFrom: ["src/lib/notifications/ai-quota-alert.ts"] },
  { module: "system", eventType: "ai_key_rejected", label: "The AI service rejected its key", sentFrom: ["src/lib/notifications/ai-quota-alert.ts"] },
  { module: "system", eventType: "activity_inactivity_digest", label: "Colleagues who have not used Phoenix lately", sentFrom: ["src/lib/notifications/inactive-user-digest.ts"] },
  { module: "system", eventType: "attendance_punch_feed_stalled", label: "Attendance punches have stopped arriving", sentFrom: ["src/lib/attendance/punch-feed-stalled-telegram.ts"] },
  { module: "system", eventType: "brick_move_net_unsettled", label: "A brick move left sales figures unsettled", sentFrom: ["src/lib/sales/master-data/brick-move-net-alert.ts"] },
  { module: "system", eventType: "brick_move_queue_stuck", label: "Brick moves are stuck in their queue", sentFrom: ["src/lib/sales/master-data/brick-move-stuck-alert.ts"] },
  { module: "system", eventType: "cv_lifecycle_link_expiring", label: "A shared CV link is about to expire", sentFrom: ["src/lib/recruitment/cv-lifecycle-link-expiry-alert.ts"] },
  { module: "system", eventType: "share_link_dead_token_polled", label: "Someone keeps opening a dead share link", sentFrom: ["src/lib/share-links/dead-token-polling-alert.ts"] },
  { module: "system", eventType: "tablet_fleet_watch", label: "Company tablets that need attention", sentFrom: ["src/lib/devices/headwind/fleet-watch-alert.ts"] },
  { module: "system", eventType: "marketing_pharmacy_code_sync_notice", label: "Pharmacy codes changed in the marketing customer list", sentFrom: ["src/lib/marketing-requests/sales-code-sync.ts"] },
  { module: "system", eventType: "milestone_due", label: "Milestones coming up", sentFrom: ["src/lib/milestones/notices.ts"] },
  { module: "system", eventType: "telegram_connection_linked", label: "Telegram is now connected to your Phoenix account", sentFrom: ["src/lib/notifications/settings.ts"] },
  { module: "system", eventType: "telegram_test", label: "A Telegram test message", sentFrom: ["app/api/integrations/telegram/test/route.ts"] },
  { module: "system", eventType: "push_test", label: "A phone push test message", sentFrom: ["app/api/notifications/push/test/route.ts"] },

  // ── Weekly plans ────────────────────────────────────────────────────────────────────────────
  { module: "weekly_plans", eventType: "plan_submitted", label: "A weekly plan is waiting for manager review", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "plan_manager_approved", label: "A weekly plan approved by the manager needs your approval", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "plan_ceo_approved", label: "A weekly plan was approved by the CEO", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "manager_approve", label: "Your weekly plan was approved by your manager", sentFrom: [WEEKLY_PLANS] },
  // The employee is told of a return or a rejection with the decision itself as the event.
  { module: "weekly_plans", eventType: "manager_reject", label: "Your weekly plan was rejected by your manager", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "manager_return", label: "Your weekly plan was returned by your manager", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "ceo_reject", label: "Your weekly plan was rejected by the CEO", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "ceo_return", label: "Your weekly plan was returned by the CEO", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "hr_acknowledge", label: "Your weekly plan was acknowledged by HR", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "plan_cancelled", label: "A weekly plan was cancelled", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "plan_comment", label: "A new comment on a weekly plan", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "plan_details_requested", label: "Visit details are needed for your weekly plan", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "plan_edit_requested", label: "An employee asked to edit a weekly plan", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "plan_edit_request_approved", label: "Your ask to edit a weekly plan was approved", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "plan_edit_request_rejected", label: "Your ask to edit a weekly plan was rejected", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "plan_monthly_resynced", label: "Your weekly plan was updated from the monthly plan", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "plan_monthly_conflict", label: "Your weekly plan disagrees with the monthly plan", sentFrom: [WEEKLY_PLANS] },
  { module: "weekly_plans", eventType: "drift_alert", label: "Weekly plans whose records and approvals disagree", sentFrom: ["src/lib/weekly-planning/drift-check.ts"] },
];

/**
 * Sends that carry no type: a person writing an email, the Telegram bot answering a message, a
 * mirror of something else. They are listed so the inventory is complete, and the test fails when
 * a new file starts sending this way without being listed here.
 */
export const UNTYPED_SENDS: ReadonlyArray<{ channel: "email" | "telegram"; file: string; label: string }> = [
  { channel: "email", file: "app/api/admin/email-reply/send/route.ts", label: "A reply written in the Email Reply Composer" },
  { channel: "email", file: "app/api/notifications/test/route.ts", label: "A test email sent from the notification settings" },
  { channel: "email", file: "src/lib/ceo-email/service.ts", label: "A letter written in the CEO Email Composer" },
  { channel: "email", file: "src/lib/sato-email/service.ts", label: "An email written in the Sato Email Composer" },
  { channel: "email", file: "src/lib/email-templates/service.ts", label: "A test send of an email template" },
  { channel: "email", file: "src/lib/recruitment/interview-invitations.ts", label: "An interview invitation to a candidate" },
  { channel: "email", file: "src/lib/recruitment/interview-notifications.ts", label: "An interview email to the candidate, built from its email template" },
  { channel: "email", file: "src/lib/vacation/email.ts", label: "A leave email built from its email template (the typed leave emails above are its fallback)" },
  { channel: "telegram", file: "app/api/integrations/telegram/webhook/route.ts", label: "The Telegram bot's reply to a person who messages it" },
  { channel: "telegram", file: "src/lib/auth/password-setup.ts", label: "A temporary password sent to the person's own Telegram" },
  { channel: "telegram", file: "src/lib/email/admin-telegram-mirror.ts", label: "The Super Admin's Telegram copy of every automated email" },
  { channel: "telegram", file: "src/lib/observability/sentry-alert-webhook.ts", label: "An error alert to the Super Admin's Telegram" },
  { channel: "telegram", file: "src/lib/recruitment/inbound/whatsapp-conversation-mirror.ts", label: "A copy of a candidate's WhatsApp conversation" },
];

// ── Readable names ────────────────────────────────────────────────────────────────────────────

export const NOTIFICATION_MODULE_LABELS: Readonly<Record<string, string>> = {
  attendance: "Attendance",
  attendance_digest: "Weekly attendance review",
  birthday: "Birthdays",
  business_card_requests: "Business cards",
  coaching: "Coaching",
  contract_renewal: "Contract renewals",
  deductions: "Deductions",
  direct_orders: "Direct orders",
  early_birds: "Early Birds",
  employee_import: "Employee import",
  excuse: "Excuses",
  holiday_confirmation: "National holidays",
  hr_ops_reports: "HR daily and weekly reports",
  hr_reminders: "HR team reminders",
  internal_messages: "Internal messages",
  mailbox_offboarding: "Mailbox offboarding",
  market_awareness: "Market Awareness",
  marketing_functions: "Marketing functions",
  marketing_requests: "Marketing requests",
  needs_you: "What needs you",
  new_hire_mailbox: "New hire mailboxes",
  offers: "Job offers",
  outstation: "Outstation",
  password_reset: "Password reset",
  password_setup: "Account setup",
  payroll: "Payroll",
  phoenix_crm: "Phoenix CRM",
  private_calendar: "Private calendar",
  probation: "Probation",
  production_planning: "Production planning",
  recruitment: "Recruitment",
  "recruitment.website-apply": "Careers website",
  resignation: "Resignation reminders",
  resignations: "Resignations",
  retention_risk: "Retention risk",
  sales: "Sales",
  support_requests: "Support requests",
  system: "System and operations",
  telegram: "Telegram",
  vacation: "Leave",
  weekly_plans: "Weekly plans",
};

export const NOTIFICATION_CHANNEL_LABELS: Readonly<Record<SystemNotificationChannel, string>> = {
  email: "Email",
  in_app: "In-app",
  push: "Phone push",
  telegram: "Telegram",
};

export const NOTIFICATION_RECIPIENT_LABELS: Readonly<Record<NotificationRecipientStrategy, string>> = {
  actor: "The person who acted",
  admin: "Administrators",
  area_manager: "Area manager",
  assigned_approver: "Assigned approver",
  cc: "People the sender names",
  department_head: "Department head",
  direct_manager: "Direct manager",
  employee: "The employee",
  hr: "HR",
  line_manager: "Line manager",
  manager_chain: "Manager chain",
  module_owner: "Module owner",
  permission_based: "Holders of the module's permission",
  request_owner: "The requester",
  role_based: "Holders of the configured roles",
  team_manager: "Team manager",
  workflow_step_approver: "The current approver",
};

export const NOTIFICATION_PRIORITY_LABELS: Readonly<Record<SystemNotificationPriority, string>> = {
  critical: "Critical",
  high: "High",
  low: "Low",
  normal: "Normal",
};

export function notificationModuleLabel(module: string): string {
  return NOTIFICATION_MODULE_LABELS[module] ?? module.replace(/[._-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// ── Reading the registry ──────────────────────────────────────────────────────────────────────

export type ListedNotificationType = NotificationTypeEntry & {
  channelLabels: string[];
  fallbackChannelLabels: string[];
  moduleLabel: string;
  policy: NotificationPolicy;
  priorityLabel: string;
  recipientLabels: string[];
};

/** Every registered type with its delivery resolved from the notification policy — the one truth. */
export function listNotificationTypes(): ListedNotificationType[] {
  return NOTIFICATION_TYPES.map((entry) => {
    const policy = resolveNotificationPolicy({ eventType: entry.eventType, module: entry.module });
    const direct = entry.delivery === "direct_email";
    return {
      ...entry,
      // A direct email is one message built by its sender: the policy plays no part in it.
      channelLabels: direct ? [NOTIFICATION_CHANNEL_LABELS.email] : policy.channels.map((channel) => NOTIFICATION_CHANNEL_LABELS[channel]),
      fallbackChannelLabels: direct ? [] : policy.fallbackChannels.map((channel) => NOTIFICATION_CHANNEL_LABELS[channel]),
      moduleLabel: notificationModuleLabel(entry.module),
      policy,
      priorityLabel: NOTIFICATION_PRIORITY_LABELS[policy.priority],
      recipientLabels: direct || policy.recipientStrategy.length === 0
        ? [NOTIFICATION_RECIPIENT_LABELS.cc]
        : policy.recipientStrategy.map((strategy) => NOTIFICATION_RECIPIENT_LABELS[strategy]),
    };
  }).sort((a, b) => a.moduleLabel.localeCompare(b.moduleLabel) || a.label.localeCompare(b.label));
}

const registeredKeys = new Set(NOTIFICATION_TYPES.map((entry) => `${entry.module}\u0000${entry.eventType}`));

export function isRegisteredNotificationType(module: string, eventType: string): boolean {
  return registeredKeys.has(`${module}\u0000${eventType}`);
}
