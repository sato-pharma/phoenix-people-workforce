import { getSupabaseAdmin } from "@/lib/supabase/server";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { logError } from "@/lib/observability/log";
import {
  canAccess,
  parseRoleStrict,
  scopeForRole,
  type AccessContext,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import type { SystemNotificationChannel, SystemNotificationPriority } from "@/lib/notifications/system";

export type NotificationRecipientStrategy =
  | "actor"
  | "admin"
  | "area_manager"
  | "assigned_approver"
  | "cc"
  | "department_head"
  | "direct_manager"
  | "employee"
  | "hr"
  | "line_manager"
  | "manager_chain"
  | "module_owner"
  | "permission_based"
  | "request_owner"
  | "role_based"
  | "team_manager"
  | "workflow_step_approver";

export type NotificationPolicy = {
  actionUrlRequired: boolean;
  auditRequired: boolean;
  bypassQuietHours: boolean;
  channels: SystemNotificationChannel[];
  fallbackChannels: SystemNotificationChannel[];
  permissionAction: PermissionAction;
  permissionResource: PermissionResource | null;
  priority: SystemNotificationPriority;
  recipientStrategy: NotificationRecipientStrategy[];
  sensitive: "none" | "payroll";
  strictRecipients: boolean;
  telegramAllowed: boolean;
  telegramGenericOnly: boolean;
};

export type NotificationRecipient = {
  email?: string | null;
  hrId?: string | null;
  name?: string | null;
  userId?: string | null;
};

export type ResolveNotificationRecipientsInput = {
  actorId?: string | null;
  eventType: string;
  metadata?: Record<string, unknown>;
  module: string;
  recordId?: string | null;
  subjectHrId?: string | null;
};

export type NotificationRecipientGovernanceWarning = {
  code: string;
  detail: string;
  strategy?: NotificationRecipientStrategy;
};

export type NotificationRecipientResolution = {
  recipients: NotificationRecipient[];
  warnings: NotificationRecipientGovernanceWarning[];
};

const defaultPolicy: NotificationPolicy = {
  actionUrlRequired: false,
  auditRequired: true,
  bypassQuietHours: false,
  channels: ["in_app", "email", "push"],
  fallbackChannels: ["in_app", "email"],
  permissionAction: "read",
  permissionResource: null,
  priority: "normal",
  recipientStrategy: ["employee"],
  sensitive: "none",
  strictRecipients: true,
  telegramAllowed: false,
  telegramGenericOnly: false,
};

const policyTable: Record<string, Partial<NotificationPolicy>> = {
  // Ops health alert, not a per-employee workflow notification — there is no employee
  // subject to resolve "employee" against (the attendance.* wildcard below), so this
  // exact-key override targets whichever admins the caller names explicitly via
  // metadata.moduleOwnerHrIds (see runAttendanceIngestionAlert), bypassing the
  // subject/org-scope matching permission_based normally requires.
  // Email retired 2026-08-08 (owner request): in-app + push only. The alert still fires — it is
  // the only automated signal that punch data has stopped reaching payroll — but it no longer
  // emails. runAttendanceIngestionAlert passes these channels explicitly too; both are kept in
  // step so a future caller relying on policy resolution cannot reintroduce the email.
  "attendance.attendance_agent_ingestion_stalled": { channels: ["in_app", "push"], permissionResource: "admin", priority: "high", recipientStrategy: ["permission_based"] },
  "attendance.*": { channels: ["in_app", "email", "push"], recipientStrategy: ["employee"] },
  // Weekly attendance review (owner rule 2026-09-17, replacing 2026-09-15's "never email"): once the
  // Super Admin releases a week, and when a disputed day is decided, the employee is told by email to
  // their own work address, by Telegram and in-app. Recipients are passed explicitly (the employee
  // the week describes), hence "cc". Email is listed before Telegram: a permanent Telegram failure
  // falls back to email only when email has not been tried yet — see attendance-digest-channels.ts.
  "attendance_digest.*": { actionUrlRequired: true, channels: ["in_app", "email", "telegram"], permissionResource: null, priority: "high", recipientStrategy: ["cc"], telegramAllowed: true },
  "birthday.*": { channels: ["in_app", "email", "push"], recipientStrategy: ["employee"] },
  "contract_renewal.renewal_reminder": { actionUrlRequired: true, channels: ["in_app", "email", "telegram", "push"], permissionResource: null, priority: "high", recipientStrategy: ["direct_manager", "workflow_step_approver"], telegramAllowed: true },
  "contract_renewal.*": { channels: ["in_app", "email", "telegram", "push"], permissionResource: "contracts", priority: "high", recipientStrategy: ["manager_chain", "permission_based"], telegramAllowed: true },
  // New-hire CRM account setup (owner instruction 2026-09-07). Recipients come from the
  // admin-editable `crm_account_setup_alert` role policy and are passed EXPLICITLY by
  // account-setup-notify.ts, so the strategy here is "role_based" — a lookup would resolve the
  // employee who was just HIRED, which is the one person this notice is not for.
  //
  // Email and in-app only, both named by the owner. Telegram and push are deliberately absent:
  // the notice carries a named new hire's mobile number and work email, and push is the channel
  // that puts those on a lock screen. The call site passes the same two channels, so this row is
  // the intent and that argument is what actually binds — they must not be allowed to drift.
  "crm_account_setup.*": { actionUrlRequired: true, channels: ["in_app", "email"], permissionResource: null, priority: "high", recipientStrategy: ["role_based"] },
  // New hire mailboxes (owner instruction 2026-09-18). Recipients come from the admin-editable
  // `new_hire_mailbox_alert` role policy and are passed EXPLICITLY by new-hire-mailbox/notify.ts,
  // hence "role_based". In-app and Telegram, NEVER email — the notice is about a mailbox that does
  // not exist yet. The call site passes the same two channels, and that argument is what binds.
  "new_hire_mailbox.*": { actionUrlRequired: true, channels: ["in_app", "telegram"], permissionResource: null, priority: "high", recipientStrategy: ["role_based"], telegramAllowed: true },
  "direct_orders.*": { actionUrlRequired: true, channels: ["in_app", "email", "telegram", "push"], permissionResource: null, priority: "high", recipientStrategy: ["workflow_step_approver", "cc"], telegramAllowed: true },
  // Recipients are supplied explicitly (the District Manager, with his NSM and RM copied), so the
  // strategy is "cc" rather than a lookup. Without an entry here it falls back to the bare default
  // policy — the silent degradation weekly_plans.* documents.
  // Owner rule 2026-08-09: in-app and Telegram only, never email. The hard guarantee is
  // early-birds-channel-guard.ts — this row is the intent, that filter is the enforcement.
  "early_birds.*": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // HR team reminders (owner, 2026-10-17): a comment under a teammate's note. IN-APP ONLY — no
  // email, no Telegram, no push: a note between four colleagues is not worth an inbox entry, and
  // the call site passes the same single channel, which is what actually binds. Recipients are
  // supplied explicitly (the note's author, the people it is shared with and everyone already in
  // the conversation), hence "cc".
  "hr_reminders.*": { actionUrlRequired: true, channels: ["in_app"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"] },
  // HR Daily & Weekly Reports (2026-10-20, src/lib/hr-ops-reports/notify.ts). Three notices, each to
  // the holders of one seat: a report is ready (the HR Operations Specialist, in-app), a report waits
  // on the decision (the Super Admin, in-app and Telegram), every row is decided (back to her,
  // in-app). Never email; the call site passes the channels, which is what binds.
  "hr_ops_reports.*": { actionUrlRequired: true, channels: ["in_app", "telegram"], permissionResource: null, priority: "normal", recipientStrategy: ["role_based"], telegramAllowed: true },
  "employee_import.*": { channels: ["in_app", "email", "push"], permissionAction: "import", permissionResource: "imports", recipientStrategy: ["permission_based"] },
  "expenses.*": { channels: ["in_app", "email", "push"], recipientStrategy: ["direct_manager"] },
  "excuse.*": { actionUrlRequired: true, channels: ["in_app", "email", "telegram", "push"], priority: "high", recipientStrategy: ["direct_manager"], telegramAllowed: true },
  "field_workforce_compliance.*": { channels: ["in_app", "email", "push"], recipientStrategy: ["permission_based"] },
  "internal_messages.*": { channels: ["in_app", "email", "push"], recipientStrategy: ["employee"] },
  // Market Awareness had NO row here at all until 2026-09-28, so every one of its notices fell
  // through to `defaultPolicy` — whose `telegramAllowed` is false. Each of the four notifiers in
  // src/lib/market-awareness/notifications.ts passes a `telegram: { ctaLabel, ctaUrl }` block, and
  // all four were silently discarded: measured on production, 10 events since 2026-09-07 produced
  // 9 in-app, 8 email, 9 push and ZERO Telegram deliveries, with nothing failed and nothing logged.
  // A missing row is indistinguishable from a deliberate one, which is exactly why it went unseen
  // for three weeks. Channels are stated in full rather than left to defaultPolicy so email can
  // never fall back to a recipient's `preferred_channel` either: this is an approval chain that
  // commits money, and the people on it read mail, not the bell.
  "market_awareness.*": {
    actionUrlRequired: true,
    channels: ["in_app", "email", "telegram", "push"],
    priority: "high",
    recipientStrategy: ["assigned_approver", "request_owner"],
    telegramAllowed: true,
  },
  // Email retired for the 2 SLA reminder types (owner request 2026-07-25, after this
  // exact notification type produced a real incident: 93 undecidable requests re-escalating an
  // unactionable "critical" email every morning) -- also hard-enforced in system.ts's
  // basePolicyChannels via enforceMarketingSlaEmailBlock (marketing-sla-channel-guard.ts), same
  // two-layer pattern as payroll.payslip_available below.
  "marketing_requests.due_date_reminder": { channels: ["in_app", "telegram", "push"], priority: "high", recipientStrategy: ["assigned_approver", "request_owner"], telegramAllowed: true },
  // The invoice obligation, not the approval SLA above it: this fires on an APPROVED request whose
  // invoice deadline has passed. `role_based` because the finance-side audience is a configured role
  // list (marketing_invoice_overdue_alert) resolved to explicit HR IDs by the caller; `request_owner`
  // because the requester is always told about their own. No email — enforced independently by
  // marketing-sla-channel-guard.ts, so a later edit to this line cannot restore it.
  "marketing_requests.invoice_overdue": { channels: ["in_app", "telegram", "push"], priority: "high", recipientStrategy: ["request_owner", "role_based"], telegramAllowed: true },
  "marketing_requests.overdue_reminder": { channels: ["in_app", "telegram", "push"], priority: "high", recipientStrategy: ["assigned_approver", "request_owner"], telegramAllowed: true },
  "marketing_requests.request_approved": { channels: ["in_app", "email", "telegram", "push"], recipientStrategy: ["request_owner", "workflow_step_approver"], telegramAllowed: true },
  "marketing_requests.request_assigned": { channels: ["in_app", "email", "telegram", "push"], priority: "high", recipientStrategy: ["assigned_approver", "cc"], telegramAllowed: true },
  "marketing_requests.request_completed": { channels: ["in_app", "email", "telegram", "push"], recipientStrategy: ["request_owner", "workflow_step_approver"], telegramAllowed: true },
  "marketing_requests.request_rejected": { channels: ["in_app", "email", "telegram", "push"], priority: "high", recipientStrategy: ["request_owner"], telegramAllowed: true },
  "marketing_requests.request_returned": { channels: ["in_app", "email", "telegram", "push"], priority: "high", recipientStrategy: ["request_owner"], telegramAllowed: true },
  // Goes to the REQUESTER as a submission confirmation, not the approver. createMarketingRequestDraft
  // emits request_assigned (recipientStrategy: assigned_approver + cc) immediately before this one,
  // with the SAME currentStep.assignedHrId — so while this row also targeted workflow_step_approver,
  // every submission sent that one person two of everything (2 emails, 2 bell items, 2 Telegram
  // messages, 2 pushes) milliseconds apart. Different eventTypes mean different idempotency keys, so
  // no dedup layer could collapse them. The metadata already carried requestOwnerHrId, which is the
  // audience this event's wording ("<code> was submitted by <name>") was always written for.
  "marketing_requests.request_submitted": { actionUrlRequired: true, channels: ["in_app", "email", "telegram", "push"], recipientStrategy: ["request_owner"], telegramAllowed: true },
  // Safety-net fallback for any marketing_requests eventType not covered by one of the
  // exact keys above, so a future/uncovered event type still gets the full channel set
  // instead of silently falling back to the bare in_app+email default.
  "marketing_requests.*": { channels: ["in_app", "email", "telegram", "push"], priority: "high", recipientStrategy: ["assigned_approver", "request_owner"], telegramAllowed: true },
  // "What needs you" — the owner's own board of decisions waiting on him.
  //
  // The default is in-app and Telegram, which is the DAILY digest (owner, 2026-09-28: Telegram daily,
  // email weekly). Email is deliberately NOT in this default: one email to B-10 is already three
  // deliveries, because send-phoenix-email.ts always BCCs his standing address and mirrors a preview
  // to his Telegram — so asking for both channels on one message means four notifications a morning
  // about one board. The weekly send passes `channels` explicitly at its own call site.
  //
  // 🔴 Email being absent here is the INTENT, never the guarantee. It re-enters from an explicit
  // call-site `channels`, from resolveBasePolicyChannels' own defaults, and from the Telegram-failure
  // fallback. needs-you-recipient-guard.ts is the enforcement: it fails closed and strips email
  // unless the recipient is provably B-10. Recipients are passed explicitly by the digest builder,
  // hence "cc" rather than a lookup — an admin-editable audience would make "B-10 only" a setting.
  "needs_you.*": { actionUrlRequired: true, channels: ["in_app", "telegram"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // A Monthly Closing published (owner, 2026-10-10): everyone seated on the line is told by email, Telegram
  // and in the app. The EMAIL is one shared message sent by closing-publish-notification.ts, so this row
  // is the per-person notice and carries in-app and Telegram only; the call site passes the same two
  // channels, and closing-publish-channel-guard.ts stops the Telegram-failure fallback from mailing a
  // second copy. No sales figure rides in the message: it reaches every rep on the line at once.
  "sales.closing_published": { actionUrlRequired: true, channels: ["in_app", "telegram"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "offers.*": { channels: ["in_app", "email", "push"], permissionResource: "offers", priority: "high", recipientStrategy: ["permission_based"] },
  "outstation.*": { channels: ["in_app", "email", "telegram", "push"], priority: "high", recipientStrategy: ["direct_manager"], telegramAllowed: true },
  // Owner request 2026-07-13: no payslip emails to employees — in-app + Telegram + push.
  // Owner override 2026-07-25: push explicitly authorized here (and for payroll.* below)
  // despite the lock-screen-exposure tradeoff — see enforcePayslipEmailBlock and
  // resolveBasePolicyChannels in system.ts, which previously hard-stripped push for any
  // isSensitivePayroll() notification and now only strip email/telegram respectively.
  "payroll.payslip_available": { channels: ["in_app", "telegram", "push"], recipientStrategy: ["employee"], sensitive: "payroll", telegramAllowed: true, telegramGenericOnly: true },
  "payroll.*": { bypassQuietHours: true, channels: ["in_app", "email", "push"], permissionResource: "payroll", priority: "critical", recipientStrategy: ["permission_based"], sensitive: "payroll" },
  "password_reset.*": { channels: ["email"], priority: "high", recipientStrategy: ["employee"] },
  "password_setup.*": { channels: ["email"], priority: "high", recipientStrategy: ["employee"] },
  // Phoenix CRM's first emailed notice (owner, 2026-10-01): each step of a rep's request to edit a week
  // he already sent — district manager, then SFE, then HR — goes by email, in-app and Telegram to the
  // next person to act, the rep, the district manager and SFE. phoenix-crm-channel-guard.ts lets these
  // four, and the first-visit notice below, through — and strips email from every other Phoenix CRM notice.
  "phoenix_crm.plan_edit_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.plan_edit_moved_on": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.plan_edit_refused": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.plan_edit_reopened": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // The expiry is the one step of a plan edit that NO PERSON takes — a daily pass closes a request
  // whose week has passed — and the owner, asked directly on 2026-10-02, chose "in-app and Telegram
  // only, no email" for it. So this row names those two and the guard enforces both halves
  // (PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES), exactly as his 06:55 digest ruling is enforced.
  "phoenix_crm.plan_edit_expired": { actionUrlRequired: true, channels: ["in_app", "telegram"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // The FIRST visit a rep ever submits on Phoenix CRM (owner, 2026-10-03): his district manager, his
  // national sales manager and the SFE Manager, by email — with the owner on the BCC, which
  // `sendPhoenixEmail` adds to every email the system sends. One per rep, ever; nothing to decide.
  "phoenix_crm.first_visit_submitted": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // "Show your manager you started working" (owner, 2026-10-03), pressed before the rep's first AM
  // visit. TWO rows for ONE piece of news, because channels are decided per event type and never per
  // recipient: the DISTRICT MANAGER's copy emails (~5 a morning), and the SFE Manager's copy does not
  // (~74 a morning at full rollout — he reads every line). `day_start_seen` is on the module's
  // push-blocked list too, so the Telegram-failure fallback cannot mail him by the back door.
  "phoenix_crm.day_start_confirmed": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.day_start_seen": { actionUrlRequired: true, channels: ["in_app", "telegram"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // The activity mirror (owner, 2026-10-05): every Phoenix CRM action to the national sales manager and
  // the SFE Managers — in-app and Telegram ONLY. It is on PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES too, so
  // the phone and the Telegram-failure email fallback are both shut; this row is the intent, that guard
  // is the enforcement. Recipients are passed explicitly by the notifier, hence "cc".
  "phoenix_crm.activity_mirror": { actionUrlRequired: true, channels: ["in_app", "telegram"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // The SFE Manager's own copy of a re-send, on the week HE returned (2026-10-08): he asked for the
  // change and nothing told him it had come back. It is informational — the plan's actionable notice
  // belongs to the reviewing manager, because the SFE returns a week and approves none — so in-app and
  // Telegram only, and it is on PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES as well, which shuts both the
  // phone and the Telegram-failure email fallback. This row is the intent, that guard the enforcement.
  // The rep's "validate this customer again" (owner, 2026-10-08): what is wrong with HIS photo, from a
  // closed list, worded about the picture and never a person. The notifier sends it in-app only, and
  // it is on PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES, which shuts the phone and the Telegram-failure email
  // fallback. This row is the intent, that guard the enforcement.
  // (2026-10-08, owner, asked about by name and answered "both") the rep's "validate this customer again" now
  // emails too, REVERSING his ruling from earlier that day; the plan reminder and approval nudge join it.
  "phoenix_crm.validation_not_confirmed": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.plan_reminder": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.approval_nudge": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.plan_resent": { actionUrlRequired: true, channels: ["in_app", "telegram"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // The hourly routine-visit rollup (owner, 2026-10-05): the batched half of the mirror — routine
  // planned visits gathered into one message an hour to the NSM and the SFE Managers. In-app and
  // Telegram ONLY, and on PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES so the phone and the Telegram-failure
  // email fallback are both shut; this row is the intent, that guard is the enforcement.
  "phoenix_crm.crm_visit_rollup": { actionUrlRequired: true, channels: ["in_app", "telegram"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // A place the Google Maps check could not confirm, waiting on the Super Admin's own page (owner,
  // 2026-10-05, naming it: "when an update here /admin/field-crm/validation-reviews I must be notified
  // by email, in app and telegram"). The module's narrowest email: one recipient — the owner, the ONE
  // decider — and only while something waits on his decision. `PHOENIX_CRM_EMAIL_EVENT_TYPES` is the
  // enforcement; this row is the intent, and the two must agree or the email-block test goes red.
  "phoenix_crm.validation_review_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // (2026-10-08, owner: "Telegram, in app, email for every action on CRM to the person responsible") every
  // person-to-person step of a plan, a request, an off-plan visit and a visit ask now emails as well.
  // PHOENIX_CRM_EMAIL_EVENT_TYPES is the enforcement; these rows are the intent and must agree with it.
  "phoenix_crm.plan_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.plan_approved": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.plan_returned": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.monthly_plan_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.monthly_plan_approved": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.monthly_plan_returned": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.grade_request_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.drop_request_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.add_request_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.restore_request_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.request_approved": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.request_refused": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.request_returned": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.request_answered": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.unplanned_visit_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.unplanned_visit_approved": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.unplanned_visit_refused": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.unplanned_visit_moved_on": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // The Administrator's decision on a recorded visit, with his comment (owner, 2026-10-17): the ONE
  // Phoenix CRM notice that emails — see PHOENIX_CRM_EMAIL_EVENT_TYPES.
  "phoenix_crm.recorded_visit_decided": { actionUrlRequired: true, channels: ["in_app", "email", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.visit_ask_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.visit_ask_accepted": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.visit_ask_declined": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // A rep's request for a double visit (owner, 2026-10-16): raised, re-dated, answered. In-app, Telegram and the phone; never email.
  "phoenix_crm.double_visit_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.double_visit_days_changed": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.double_visit_accepted": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.double_visit_declined": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // The district manager's weekly plan (owner, 2026-10-16): sent, decided, asked to edit, own-list removals. Never email; the expiry never the phone.
  "phoenix_crm.manager_plan_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.manager_plan_approved": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.manager_plan_returned": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.manager_plan_edit_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.manager_plan_edit_reopened": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.manager_plan_edit_refused": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.manager_plan_edit_expired": { actionUrlRequired: true, channels: ["in_app", "telegram"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.manager_list_removal_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.manager_list_removal_decided": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.manager_single_visit_day_waiting": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.manager_single_visit_day_decided": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "phoenix_crm.manager_single_visit_day_expired": { actionUrlRequired: true, channels: ["in_app", "telegram"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  // Phoenix CRM (owner rule 2026-09-16): a grade or drop request and a weekly plan waiting for the
  // reviewing manager, and the decision back to the rep — in-app, Telegram and (since 2026-10-02) the
  // phone; email only for the event types named above (since 2026-10-08).
  // Recipients are passed explicitly (src/lib/phoenix-crm/server/notifications.ts), hence "cc". The
  // hard guarantee is phoenix-crm-channel-guard.ts — this row is the intent, that filter is the
  // enforcement.
  "phoenix_crm.*": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], permissionResource: null, priority: "normal", recipientStrategy: ["cc"], telegramAllowed: true },
  "probation.reminder_due": { actionUrlRequired: true, channels: ["in_app", "email", "telegram", "push"], permissionResource: null, priority: "high", recipientStrategy: ["direct_manager", "workflow_step_approver"], telegramAllowed: true },
  "probation.*": { channels: ["in_app", "email", "telegram", "push"], permissionResource: "probation", priority: "high", recipientStrategy: ["direct_manager", "permission_based"], telegramAllowed: true },
  // Owner request 2026-08-15: the "new CV received" notice must never be emailed — in-app and
  // Telegram only. The hard guarantee is recruitment-cv-channel-guard.ts — this row is the
  // intent, that filter is the enforcement (same two-layer pattern as early_birds.* above).
  "recruitment.recruitment_inbound_cv": { channels: ["in_app", "telegram", "push"], telegramAllowed: true },
  // The once-a-Cairo-day summary that replaced the per-CV alert (628 deliveries to 3 reviewers in
  // 30 days). Same rule, same two layers — it needs its own row because `recruitment.*` below
  // carries email, so falling through would have emailed the very notice the owner said must not be.
  "recruitment.recruitment_daily_cv_digest": { channels: ["in_app", "telegram", "push"], telegramAllowed: true },
  // Owner rule 2026-08-24: pushing a candidate to a hiring manager must never be emailed — in-app,
  // Telegram and push. Needs its own row for the same reason the two CV rows above do:
  // `recruitment.*` below carries email, so falling through would email the very notice the owner
  // said must not. The hard guarantee is recruitment-candidate-assigned-channel-guard.ts; this row
  // is the intent. Telegram added the same day on the owner's follow-up — it is what reaches a
  // sales manager in the field, and the recruitment module is governed enabled/non-generic, so the
  // names in the message survive rather than collapsing to a bare "you have a notification".
  "recruitment.candidate_assigned": { channels: ["in_app", "telegram", "push"], permissionResource: "recruitment", recipientStrategy: ["assigned_approver", "permission_based"], telegramAllowed: true },
  "recruitment.*": { channels: ["in_app", "email", "push"], permissionResource: "recruitment", recipientStrategy: ["assigned_approver", "permission_based"] },
  // Owner-set 2026-08-09: a resignation is told to Super Admin and Talent Acquisition ONLY —
  // deliberately not the CEO, and deliberately not the leaver's manager chain. The emitter
  // supplies those people explicitly via metadata.moduleOwnerHrIds (resolved from the
  // admin-editable `resignation_workflow_alert` role policy), which permission_based consumes
  // directly; `manager_chain` was removed so a resignation never fans out up the org chart.
  // Explicit recipients still have to hold `resignations` permission to survive canAccess.
  "resignations.*": { channels: ["in_app", "email", "telegram", "push"], permissionResource: "resignations", priority: "high", recipientStrategy: ["permission_based"], telegramAllowed: true },
  // House rule for lateness reminders since 2026-07-25: in-app, Telegram and push, never email.
  // The call site in distributor-upload-nudge.ts passes these same three explicitly, and an
  // explicit `channels` wins over this table (resolveBasePolicyChannels, first line) — so this row
  // is the INDEPENDENT layer, the one that still holds if that argument is ever dropped. Without it
  // the bare default applies, and that default carries email and omits Telegram: the exact inverse
  // of the rule, arrived at silently.
  "sales.distributor_upload_overdue": { channels: ["in_app", "telegram", "push"], priority: "high", recipientStrategy: ["role_based"], telegramAllowed: true },
  // IN-APP AND TELEGRAM, NEVER EMAIL. Owner instruction 2026-09-07, in review: "remove email keep
  // in-app and telegram". His original request on 2026-09-06 did say email, and this reverses that
  // half of it — the recipients he picked are unchanged. The alert names a colleague as a possible
  // resignation risk, and email is the half that leaves a durable copy of that in four inboxes
  // indefinitely; the house already draws this line for Early Birds, "new CV received" and a
  // candidate push to a hiring manager.
  //
  // THESE ROWS ARE THE HALF THAT ACTUALLY HOLDS. The call site passes the same list explicitly and
  // an explicit `channels` wins, so if these rows still carried email they would restore it the
  // moment that argument was dropped — the bare default carries email and omits Telegram, which is
  // the exact inverse of the rule. Two co-operating config values are precisely what drifts apart.
  //
  // Push is absent too: it is the only channel that renders a named employee and the words "no CRM
  // activity" on a phone's lock screen, and he never asked for it.
  //
  // No `permissionResource`: recipients are resolved from the admin-editable role policy and from
  // the subject's own reporting line, and a District Manager — the whole point of naming the line
  // manager — holds no company-wide HR resource to be gated on.
  "retention_risk.retention_risk_flagged": { channels: ["in_app", "telegram"], priority: "high", recipientStrategy: ["role_based"], telegramAllowed: true },
  "retention_risk.retention_risk_pre_payroll": { channels: ["in_app", "telegram"], priority: "high", recipientStrategy: ["role_based"], telegramAllowed: true },
  "system.announcement": { channels: ["in_app", "email", "push"], recipientStrategy: ["employee"] },
  // Live sender (telegram-operations.ts) passes explicit channels and doesn't consult this
  // entry today, but kept push-inclusive here too in case a future caller relies on policy
  // resolution instead of hardcoding channels.
  "telegram.daily_hr_digest": { actionUrlRequired: true, channels: ["in_app", "telegram", "push"], priority: "normal", recipientStrategy: ["workflow_step_approver"], telegramAllowed: true },
  "telegram.delivery_escalation": { actionUrlRequired: true, bypassQuietHours: true, channels: ["in_app", "email", "telegram", "push"], priority: "high", recipientStrategy: ["workflow_step_approver"], telegramAllowed: true },
  "vacation.request_submitted": { actionUrlRequired: true, channels: ["in_app", "email", "telegram", "push"], recipientStrategy: [], telegramAllowed: true },
  "vacation.*": { channels: ["in_app", "email", "telegram", "push"], permissionResource: "leave", priority: "high", recipientStrategy: ["manager_chain", "permission_based"], telegramAllowed: true },
  // No policyTable entry existed for weekly_plans before — it silently fell back to the bare
  // defaultPolicy (in_app+email only). The live sender (weekly-planning/service.ts) passes its
  // own explicit channels including telegram+push already; this wildcard covers the other
  // caller (drift-check.ts) that relies on policy resolution.
  "weekly_plans.*": { channels: ["in_app", "email", "push"], priority: "high", recipientStrategy: ["direct_manager", "permission_based"] },
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanHrId(value: unknown) {
  return cleanText(value).toUpperCase();
}

function policyKey(moduleName: string, eventType: string) {
  return `${cleanText(moduleName).toLowerCase()}.${cleanText(eventType).toLowerCase()}`;
}

export function resolveNotificationPolicy(input: Pick<ResolveNotificationRecipientsInput, "eventType" | "module">): NotificationPolicy {
  const exact = policyTable[policyKey(input.module, input.eventType)];
  const wildcard = policyTable[`${cleanText(input.module).toLowerCase()}.*`];
  const merged = { ...defaultPolicy, ...(wildcard ?? {}), ...(exact ?? {}) };
  return {
    ...merged,
    channels: Array.from(new Set(merged.channels)),
    fallbackChannels: Array.from(new Set(merged.fallbackChannels)),
    recipientStrategy: Array.from(new Set(merged.recipientStrategy)),
  };
}

function schemaMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return text.includes("schema cache") || text.includes("does not exist") || text.includes("could not find the table");
}

function metadataText(metadata: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = cleanText(metadata?.[key]);
    if (value) return value;
  }
  return "";
}

function metadataTexts(metadata: Record<string, unknown> | undefined, keys: string[]) {
  const output: string[] = [];
  for (const key of keys) {
    const value = metadata?.[key];
    if (Array.isArray(value)) {
      output.push(...value.map(cleanHrId).filter(Boolean));
    } else {
      const text = cleanHrId(value);
      if (text) output.push(text);
    }
  }
  return Array.from(new Set(output));
}

type EmployeeRecipientRow = {
  area_id?: number | null;
  department_id?: number | null;
  employment_status?: string | null;
  full_name?: string | null;
  hr_id?: string | null;
  line_id?: number | null;
  manager_hr_id?: string | null;
  nickname?: string | null;
  team_id?: number | null;
  work_email?: string | null;
};

type AuthRecipientRow = {
  auth_email?: string | null;
  hr_id?: string | null;
  is_active?: boolean | null;
  line?: string | null;
  login_id?: string | null;
  manager_hr_id?: string | null;
  name?: string | null;
  role?: string | null;
};

type RecipientCandidate = {
  auth: AuthRecipientRow | null;
  employee: EmployeeRecipientRow | null;
  recipient: NotificationRecipient;
  role: PhoenixRole | null;
};

/**
 * Eligibility as a notification RECIPIENT. Exported so the rule is testable
 * directly: treating a resignation's SUBJECT with this same predicate is what
 * silently killed every resignation notification (see candidateByHrId).
 */
export function isActiveEmployee(employee: EmployeeRecipientRow | null | undefined) {
  const status = cleanText(employee?.employment_status).toLowerCase();
  return !status || status === "active" || status === "on_leave";
}

function roleFrom(value: unknown) {
  const normalized = cleanText(value);
  if (!normalized) return null;
  try {
    return parseRoleStrict(normalized);
  } catch {
    return null;
  }
}

function recipientFromCandidate(candidate: Pick<RecipientCandidate, "auth" | "employee" | "role">): NotificationRecipient {
  return {
    // The employee work_email is the only deliverable address. `auth_email` is the synthetic
    // Supabase-auth login key (phx-<hex>@auth.phoenix.local) and must NEVER be emailed — it
    // hard-bounces. No real email → null (recipient still gets the in-app notification).
    email: pickDeliverableEmail(candidate.employee?.work_email, candidate.auth?.auth_email),
    hrId: cleanHrId(candidate.auth?.hr_id ?? candidate.employee?.hr_id) || null,
    name:
      candidate.auth?.name ??
      (candidate.employee?.full_name
        ? resolveEmployeeDisplayName(candidate.employee.full_name, candidate.employee.nickname)
        : null),
    userId: candidate.auth?.login_id ?? null,
  };
}

async function authUserByHrId(hrId: string | null | undefined): Promise<AuthRecipientRow | null> {
  const normalized = cleanHrId(hrId);
  if (!normalized) return null;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,name,auth_email,role,is_active,line,manager_hr_id")
      .eq("hr_id", normalized)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as AuthRecipientRow | null;
  } catch (error) {
    if (!schemaMissing(error)) {
      logError("Notification auth recipient lookup failed", {
        labels: { event: "notification_auth_recipient_lookup_failed", hr_id: normalized },
        error,
      });
    }
    return null;
  }
}

/**
 * Options for looking a person up as a notification participant.
 *
 * `includeInactive` exists for one specific, narrow case: the SUBJECT a
 * notification is about. A resignation, termination or exit notification is by
 * definition about somebody who has just stopped being active, so applying the
 * active-employee filter to the subject makes the subject unresolvable at
 * exactly the moment the notification matters.
 *
 * This must NEVER be used for a RECIPIENT. Recipients still come from
 * activeAuthCandidates()/employeeByHrId() with the active filter intact, so a
 * departed person is never mailed and the fail-closed governance guard keeps
 * its full strength.
 */
type RecipientLookupOptions = { includeInactive?: boolean };

async function candidateByHrId(
  hrId: string | null | undefined,
  options?: RecipientLookupOptions,
): Promise<RecipientCandidate | null> {
  const normalized = cleanHrId(hrId);
  if (!normalized) return null;

  try {
    const [{ data: employeeData, error: employeeError }, auth] = await Promise.all([
      getSupabaseAdmin()
      .from("employees")
        .select("hr_id,full_name,nickname,work_email,manager_hr_id,department_id,line_id,area_id,team_id,employment_status")
      .eq("hr_id", normalized)
      .limit(1)
        .maybeSingle(),
      authUserByHrId(normalized),
    ]);
    if (employeeError) throw employeeError;
    const employee = employeeData as EmployeeRecipientRow | null;
    if (!employee) return null;
    if (!options?.includeInactive && !isActiveEmployee(employee)) return null;
    const role = roleFrom(auth?.role);
    const candidate = { auth, employee, role };
    return { ...candidate, recipient: recipientFromCandidate(candidate) };
  } catch (error) {
    if (!schemaMissing(error)) {
      logError("Notification employee recipient lookup failed", {
        labels: { event: "notification_employee_recipient_lookup_failed", hr_id: normalized },
        error,
      });
    }
    return null;
  }
}

async function employeeByHrId(
  hrId: string | null | undefined,
  options?: RecipientLookupOptions,
): Promise<NotificationRecipient | null> {
  return (await candidateByHrId(hrId, options))?.recipient ?? null;
}

async function candidatesByHrIds(hrIds: string[]): Promise<Map<string, RecipientCandidate>> {
  const normalized = Array.from(new Set(hrIds.map(cleanHrId).filter(Boolean)));
  const output = new Map<string, RecipientCandidate>();
  if (normalized.length === 0) return output;

  try {
    const [{ data: employeeData, error: employeeError }, { data: authData, error: authError }] = await Promise.all([
      getSupabaseAdmin()
        .from("employees")
        .select("hr_id,full_name,nickname,work_email,manager_hr_id,department_id,line_id,area_id,team_id,employment_status")
        .in("hr_id", normalized),
      getSupabaseAdmin()
        .from("app_auth_users")
        .select("login_id,hr_id,name,auth_email,role,is_active,line,manager_hr_id")
        .in("hr_id", normalized)
        .eq("is_active", true),
    ]);
    if (employeeError) throw employeeError;
    if (authError) throw authError;

    const employeesByHrId = new Map(((employeeData ?? []) as EmployeeRecipientRow[]).map((row) => [cleanHrId(row.hr_id), row] as const));
    const authByHrId = new Map(((authData ?? []) as AuthRecipientRow[]).map((row) => [cleanHrId(row.hr_id), row] as const));

    for (const hrId of normalized) {
      const employee = employeesByHrId.get(hrId) ?? null;
      if (!employee || !isActiveEmployee(employee)) continue;
      const auth = authByHrId.get(hrId) ?? null;
      const role = roleFrom(auth?.role);
      const candidate = { auth, employee, role };
      output.set(hrId, { ...candidate, recipient: recipientFromCandidate(candidate) });
    }
    return output;
  } catch (error) {
    if (!schemaMissing(error)) {
      logError("Notification batch recipient lookup failed", {
        labels: { event: "notification_batch_recipient_lookup_failed" },
        error,
      });
    }
    return output;
  }
}

async function activeAuthCandidates() {
  try {
    const [{ data: authData, error: authError }, { data: employeeData, error: employeeError }] = await Promise.all([
      getSupabaseAdmin()
      .from("app_auth_users")
        .select("login_id,hr_id,name,auth_email,role,is_active,line,manager_hr_id")
        .eq("is_active", true),
      getSupabaseAdmin()
        .from("employees")
        .select("hr_id,full_name,nickname,work_email,manager_hr_id,department_id,line_id,area_id,team_id,employment_status"),
    ]);
    if (authError) throw authError;
    if (employeeError) throw employeeError;
    const employeesByHrId = new Map(
      ((employeeData ?? []) as EmployeeRecipientRow[])
        .map((row) => [cleanHrId(row.hr_id), row] as const)
        .filter((entry): entry is [string, EmployeeRecipientRow] => Boolean(entry[0]) && isActiveEmployee(entry[1])),
    );

    return ((authData ?? []) as AuthRecipientRow[])
      .map((auth) => {
        const role = roleFrom(auth.role);
        const employee = employeesByHrId.get(cleanHrId(auth.hr_id)) ?? null;
        const candidate = { auth, employee, role };
        return { ...candidate, recipient: recipientFromCandidate(candidate) };
      })
      .filter((candidate) => candidate.role && candidate.recipient.hrId);
  } catch (error) {
    if (!schemaMissing(error)) {
      logError("Notification active auth recipient lookup failed", {
        labels: { event: "notification_active_auth_recipient_lookup_failed" },
        error,
      });
    }
    return [];
  }
}

/**
 * The manager(s) of `hrId`. `options` applies ONLY to looking up `hrId` itself —
 * the person the chain starts from, who may legitimately be inactive (a leaver).
 * The manager returned is always resolved with the active filter intact, because
 * the manager is the RECIPIENT.
 */
async function managerFor(hrId: string | null | undefined, options?: RecipientLookupOptions) {
  const employee = await employeeByHrId(hrId, options);
  if (!employee?.hrId) return [];
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("manager_hr_id")
      .eq("hr_id", employee.hrId)
      .maybeSingle();
    if (error) throw error;
    const managerHrId = (data as { manager_hr_id?: string | null } | null)?.manager_hr_id;
    // No options here on purpose: a departed manager must not be notified.
    const manager = await employeeByHrId(managerHrId);
    return manager ? [manager] : [];
  } catch (error) {
    if (!schemaMissing(error)) {
      logError("Notification manager recipient lookup failed", {
        labels: { event: "notification_manager_recipient_lookup_failed", hr_id: employee.hrId },
        error,
      });
    }
    return [];
  }
}

async function managerChainFor(hrId: string | null | undefined, maxDepth = 4) {
  const output: NotificationRecipient[] = [];
  const visited = new Set<string>();
  let current = cleanHrId(hrId);

  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    // Only the first hop is the subject (who may be a leaver); every hop after
    // that is a manager already resolved under the active filter.
    const managers = await managerFor(current, depth === 0 ? { includeInactive: true } : undefined);
    const manager = managers[0];
    const managerHrId = cleanHrId(manager?.hrId);
    if (!managerHrId || visited.has(managerHrId)) break;
    output.push(manager);
    visited.add(managerHrId);
    current = managerHrId;
  }

  return output;
}

async function explicitRecipientCandidates(input: ResolveNotificationRecipientsInput, keys: string[]) {
  const hrIds = metadataTexts(input.metadata, keys);
  const candidateMap = await candidatesByHrIds(hrIds);
  return hrIds
    .map((hrId) => candidateMap.get(cleanHrId(hrId)))
    .filter((candidate): candidate is RecipientCandidate => Boolean(candidate?.recipient.hrId));
}

function accessContextFor(candidate: RecipientCandidate): AccessContext | null {
  if (!candidate.role || !candidate.recipient.hrId) return null;
  return {
    hrId: candidate.recipient.hrId,
    loginId: candidate.recipient.userId,
    role: candidate.role,
    scope: scopeForRole(candidate.role),
    source: "session",
  };
}

function reportsTo(candidate: RecipientCandidate, subject: RecipientCandidate | null) {
  return Boolean(subject?.employee?.manager_hr_id && cleanHrId(subject.employee.manager_hr_id) === candidate.recipient.hrId);
}

function inManagerChain(candidate: RecipientCandidate, subject: RecipientCandidate | null, employeesByHrId: Map<string, EmployeeRecipientRow>) {
  if (!candidate.recipient.hrId || !subject?.recipient.hrId) return false;
  const visited = new Set<string>();
  let managerHrId = cleanHrId(subject.employee?.manager_hr_id);
  while (managerHrId) {
    if (managerHrId === candidate.recipient.hrId) return true;
    if (visited.has(managerHrId)) return false;
    visited.add(managerHrId);
    managerHrId = cleanHrId(employeesByHrId.get(managerHrId)?.manager_hr_id);
  }
  return false;
}

async function permissionBasedRecipients(input: ResolveNotificationRecipientsInput, policy: NotificationPolicy, subject: RecipientCandidate | null) {
  if (!policy.permissionResource) return [];
  const explicit = await explicitRecipientCandidates(input, ["permissionRecipientHrId", "permissionRecipientHrIds", "moduleOwnerHrId", "moduleOwnerHrIds"]);
  const candidates = explicit.length > 0 ? explicit : await activeAuthCandidates();
  const employeesByHrId = new Map(
    candidates
      .map((candidate) => [candidate.recipient.hrId ?? "", candidate.employee] as const)
      .filter((entry): entry is [string, EmployeeRecipientRow] => Boolean(entry[0] && entry[1])),
  );
  if (subject?.employee && subject.recipient.hrId) employeesByHrId.set(subject.recipient.hrId, subject.employee);

  const output: NotificationRecipient[] = [];
  for (const candidate of candidates) {
    const context = accessContextFor(candidate);
    if (!context || !await canAccess(context, policy.permissionResource, policy.permissionAction)) continue;
    if (explicit.length > 0) {
      output.push(candidate.recipient);
      continue;
    }
    // Company/system-scope roles (e.g. Super Admin, CEO) already see every employee, so they
    // never have to match the subject's org chain — and this MUST be decided before the
    // `!subject` bail below. Many operational alerts have no subject at all (an ingestion
    // stall, a completed employee import); resolving those hit `if (!subject) continue` first
    // and so rejected every candidate INCLUDING company-scope ones, leaving zero recipients.
    // The fail-closed guard then skipped the alert on every channel while writing rows that
    // made cron look healthy. Ordering is the whole fix: nothing new is accepted here that the
    // clause below did not already accept whenever a subject happened to exist.
    if (context.scope === "company" || context.scope === "system") {
      output.push(candidate.recipient);
      continue;
    }
    if (!subject) continue;
    if (
      candidate.recipient.hrId === subject.recipient.hrId ||
      reportsTo(candidate, subject) ||
      inManagerChain(candidate, subject, employeesByHrId)
    ) {
      output.push(candidate.recipient);
    }
  }
  return output;
}

export async function resolveNotificationRecipientsWithGovernance(input: ResolveNotificationRecipientsInput): Promise<NotificationRecipientResolution> {
  const policy = resolveNotificationPolicy(input);
  const subjectHrId = cleanHrId(input.subjectHrId || metadataText(input.metadata, ["employeeHrId", "subjectHrId", "requestOwnerHrId"]));
  // The SUBJECT may be inactive — a resignation/termination notification is about
  // somebody who has just stopped being active. Resolving the subject under the
  // active filter returned null for every resignation, which emptied BOTH
  // manager_chain (nothing to walk from) and permission_based (`if (!subject)
  // continue` skips every candidate, including company-scope Super Admin/CEO),
  // so the fail-closed guard skipped all four channels. Recipients are still
  // resolved with the active filter, so nobody departed is ever notified.
  const subject = subjectHrId ? await candidateByHrId(subjectHrId, { includeInactive: true }) : null;
  const recipients: NotificationRecipient[] = [];
  const warnings: NotificationRecipientGovernanceWarning[] = [];

  for (const strategy of policy.recipientStrategy) {
    if (strategy === "employee" || strategy === "request_owner") {
      const ownerHrId = strategy === "request_owner" ? metadataText(input.metadata, ["requestOwnerHrId"]) : subjectHrId;
      const employee = await employeeByHrId(ownerHrId);
      if (employee) recipients.push(employee);
      else warnings.push({ code: "recipient_not_resolved", detail: `${strategy} was not resolved.`, strategy });
    } else if (strategy === "direct_manager") {
      const managers = await managerFor(subjectHrId, { includeInactive: true });
      if (managers.length > 0) recipients.push(...managers);
      else warnings.push({ code: "direct_manager_missing", detail: "Direct manager could not be resolved.", strategy });
    } else if (strategy === "manager_chain") {
      const chain = await managerChainFor(subjectHrId);
      if (chain.length > 0) recipients.push(...chain);
      else warnings.push({ code: "manager_chain_missing", detail: "Manager chain could not be resolved.", strategy });
    } else if (strategy === "line_manager") {
      const scoped = await explicitRecipientCandidates(input, ["lineManagerHrId", "lineManagerHrIds"]);
      recipients.push(...scoped.map((candidate) => candidate.recipient).filter((recipient) => recipient.hrId));
      if (scoped.length === 0) warnings.push({ code: "line_manager_missing", detail: "Line manager must be explicit; no broad line fallback was used.", strategy });
    } else if (strategy === "department_head") {
      const scoped = await explicitRecipientCandidates(input, ["departmentHeadHrId", "departmentHeadHrIds"]);
      recipients.push(...scoped.map((candidate) => candidate.recipient).filter((recipient) => recipient.hrId));
      if (scoped.length === 0) warnings.push({ code: "department_head_missing", detail: "Department head must be explicit; no broad department fallback was used.", strategy });
    } else if (strategy === "area_manager") {
      const scoped = await explicitRecipientCandidates(input, ["areaManagerHrId", "areaManagerHrIds"]);
      recipients.push(...scoped.map((candidate) => candidate.recipient).filter((recipient) => recipient.hrId));
      if (scoped.length === 0) warnings.push({ code: "area_manager_missing", detail: "Area manager must be explicit; no broad area fallback was used.", strategy });
    } else if (strategy === "team_manager") {
      const scoped = await explicitRecipientCandidates(input, ["teamManagerHrId", "teamManagerHrIds"]);
      recipients.push(...scoped.map((candidate) => candidate.recipient).filter((recipient) => recipient.hrId));
      if (scoped.length === 0) warnings.push({ code: "team_manager_missing", detail: "Team manager must be explicit; no broad team fallback was used.", strategy });
    } else if (strategy === "cc") {
      const scoped = await explicitRecipientCandidates(input, ["ccHrIds"]);
      recipients.push(...scoped.map((candidate) => candidate.recipient).filter((recipient) => recipient.hrId));
      if (scoped.length === 0) warnings.push({ code: "cc_recipient_missing", detail: "CC recipients must be explicit; no fallback was used.", strategy });
    } else if (strategy === "hr" || strategy === "admin" || strategy === "module_owner" || strategy === "permission_based") {
      const scoped = await permissionBasedRecipients(input, policy, subject);
      if (scoped.length > 0) recipients.push(...scoped);
      else warnings.push({ code: "permission_recipient_missing", detail: `${strategy} requires exact permission and organizational scope; no broad fallback was used.`, strategy });
    } else if (strategy === "assigned_approver" || strategy === "workflow_step_approver" || strategy === "role_based") {
      const keys = strategy === "assigned_approver"
        ? ["assignedApproverHrId", "assignedApproverHrIds"]
        : strategy === "workflow_step_approver"
          ? ["workflowApproverHrId", "workflowApproverHrIds", "workflowStepApproverHrId", "workflowStepApproverHrIds", "approverHrId", "approverHrIds", "escalationOwnerHrId", "workflowParticipantHrIds"]
          : ["roleRecipientHrId", "roleRecipientHrIds", "recipientHrId", "recipientHrIds"];
      const explicit = await explicitRecipientCandidates(input, keys);
      if (explicit.length > 0) recipients.push(...explicit.map((candidate) => candidate.recipient));
      else warnings.push({ code: "explicit_recipient_missing", detail: `${strategy} requires an explicit recipient; no manager/HR fallback was used.`, strategy });
    } else if (strategy === "actor") {
      const actor = await employeeByHrId(input.actorId);
      if (actor) recipients.push(actor);
      else warnings.push({ code: "actor_missing", detail: "Actor recipient could not be resolved.", strategy });
    }
  }

  const seen = new Set<string>();
  const resolved = recipients.filter((recipient) => {
    const key = cleanText(recipient.userId || recipient.hrId || recipient.email).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (policy.strictRecipients && resolved.length === 0) {
    warnings.push({ code: "notification_governance_fail_closed", detail: "No exact authorized recipient resolved; notification must be skipped." });
  }
  return { recipients: resolved, warnings };
}

export async function resolveNotificationRecipients(input: ResolveNotificationRecipientsInput): Promise<NotificationRecipient[]> {
  return (await resolveNotificationRecipientsWithGovernance(input)).recipients;
}
