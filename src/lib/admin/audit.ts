
import { persistAuditLogThroughOutbox } from "@/lib/admin/audit-outbox";
import { getOperationalAuditLogs } from "@/lib/operations/events";
import { logError } from "@/lib/observability/log";

export type AuditEntityType =
  // Bulk repointing of rows from one area to another, performed by the Super Admin from the Area
  // Consolidation screen. Written with `writeRequiredAuditLog` — a bulk org move that leaves no
  // audit trail is treated as a failed move, not a quiet success.
  | "area_consolidation"
  // The weekly attendance digest, rebuilt 2026-09-08. Five entity types rather than one
  // because they answer different questions and none contains the others: what the system
  // generated for a week, what the employee said about a day, what they objected to, what a
  // reviewer decided, and what was applied to payroll at month end. The middle three are the
  // only record of an employee's own answer — a deduction that reaches a payslip through the
  // auto-confirm path was decided by nobody, so the audit row is the whole story of how it
  // got there.
  | "attendance_digest_bridge_run"
  | "attendance_digest_confirm"
  | "attendance_digest_dispute"
  | "attendance_digest_dispute_review"
  // Added 2026-10-20: one run carrying the Super Admin's decisions in the HR daily and weekly reports
  // into the weekly attendance review (src/lib/hr-ops-reports/bridge.ts) — the counts only.
  | "hr_ops_report_bridge_run"
  // Added 2026-10-20: the Super Admin deciding rows of one HR daily or weekly report — how many were
  // decided and whether the bridge ran (app/api/hr-ops-reports/[id]/decide). Days only, never EGP.
  | "hr_ops_report"
  // Added 2026-09-15 with the release step: the Super Admin taking a day out before anyone sees
  // it, releasing a week to its employees, the employee's salary-or-balance choice, and the daily
  // job settling an unanswered day to salary once its deadline passed.
  | "attendance_digest_line_removed"
  // The Super Admin ticking a day for deduction, or changing its days, before release (2026-09-15).
  | "attendance_digest_line_marked"
  | "attendance_digest_release"
  | "attendance_digest_answer"
  | "attendance_digest_auto_salary"
  | "attendance_weekly_digest_run"
  | "attendance_holiday_override"
  | "attendance_settlement"
  | "attendance_settlement_correction"
  | "auth_session"
  // The Business Review workbook export. The window is part of the entity id, so an audit row
  // says WHICH period was handed over, not just that something was.
  | "business_review_export"
  // Retired name, kept in the union so historical audit rows still typecheck. Nothing writes
  // it any more: the module stopped being a fixed S1 report when it grew a period filter.
  | "business_review_s1_export"
  // The self-service Sales Review pack (2026-09-26). ITS OWN TYPE rather than folded into
  // `business_review_export`, because the two hand over different things: the export is the fixed
  // company workbook, while the pack is a CHOSEN-METRICS performance document about NAMED people,
  // scoped to one territory and built in whatever format was asked for. Its row carries the metrics
  // that were ticked, so "who pulled a pack covering this district, and what was in it" stays
  // answerable without reading the newValues of every export row ever written.
  | "business_review_pack"
  | "calendar_event"
  // The device register. `company_device` is the asset — registered, sent for repair, marked lost,
  // stolen or retired. `device_assignment` is one custody event against it — issued, returned, or
  // written off.
  //
  // TWO ENTITY TYPES RATHER THAN ONE, because they answer different questions and neither answer
  // contains the other: "what has happened to this laptop over its life" is the device, and "what
  // did this person sign for and what became of it" is the assignment. Folding them together would
  // make the second unanswerable without reading every row of the first.
  //
  // Every write against both is REQUIRED audit, not best-effort. Each one attests that a named
  // person physically handed over, received back, or stopped pursuing a company asset — and two of
  // them (a damaged return, a write-off) can end in money coming out of somebody's wages under
  // البند (10) of the custody receipt.
  | "company_device"
  | "device_assignment"
  // A device import ATTEMPT, which is a different fact from its result. `company_device` is written
  // when a device lands; nothing at all was written when an import was refused — so a failed import
  // and an import that never reached the server looked identical from the database, and on
  // 2026-09-08 that ambiguity cost an evening. One row per press, whatever came of it.
  //
  // Best-effort (`writeAuditLog`), unlike the two above: a diagnostic that can fail the import it
  // was only meant to observe is worse than the blindness it replaces.
  | "device_import"
  // Rep Tablets (2026-09-18). `android_device_policy` is a push of the `rep-tablet` policy to Google —
  // the rules and app list every enrolled tablet follows, so one row can change every rep's tablet
  // at once. `android_enrollment_token` is one enrollment code made, recording which register tablet
  // it was for, how long it lasts and whether it works once.
  //
  // Both REQUIRED, written after Google has answered. The token row NEVER holds the code or the QR
  // payload: either one enrols a device into the fleet until it expires, and an audit trail that
  // stores the credential it audits hands it to every reader of the log.
  | "android_device_policy"
  | "android_enrollment_token"
  // 🔴 THE SIX manageengine_* TYPES BELOW ARE NO LONGER WRITTEN — the ManageEngine bridge was deleted on
  // 2026-10-23. They stay so the rows already in audit_logs keep a known type; never write one again.
  // Rep Tablets remote actions (2026-09-24). One row per remote command Phoenix issued to a tablet
  // through the ManageEngine MDM API — lock, restart, reset the screen lock, lost mode on or off,
  // and the two wipes. REQUIRED audit, written after ManageEngine has accepted the command: each one
  // reaches a real tablet in a rep's hands, and the two wipes erase it, so a command that leaves no
  // trace is treated as a failed command. The row names the tablet by its custody asset tag, never
  // by any credential.
  | "manageengine_device_command"
  // The same act, on the company's OWN Headwind MDM server (2026-09-25) — apply settings, wake the
  // remote app, restart, lock, locate, kiosk on and off, and the factory reset. A separate type from
  // the row above because the two consoles are separate systems during the changeover and "what was
  // done to this tablet" must be answerable per system; the `messageType` actually sent is recorded
  // beside the action, so a command whose wire name is later corrected is still readable afterwards.
  | "headwind_device_command"
  // A tablet CONFIGURATION on the company's own Headwind server (2026-09-25) — the rules a tablet
  // follows, rather than any one tablet. Apart from the command row above because it reaches every
  // tablet carrying that configuration at once, and keeps reaching new ones: attaching an app, sending
  // a file, writing the kiosk branding or moving a tablet onto a different set of rules all land here.
  // 🔴 A configuration carries a PLAINTEXT device password, so the row records WHICH configuration and
  // WHAT changed about it, and never the object itself — an audit trail that stores the credential it
  // audits hands it to every reader of the log.
  | "headwind_configuration"
  // The Headwind enrolment code (2026-09-25) — the QR a tablet is set up from. One row, the same shape
  // the ManageEngine enrolment card already uses: the row carries the FACTS about the code (which
  // server, which configuration, when it was stored, who stored it, who asked to see it) and NEVER the
  // payload, because the payload is the enrolment.
  | "headwind_enrollment"
  // A console login on the company's own Headwind server (2026-09-25) — added, changed or retired.
  // Apart from Phoenix's own user rows because this is a second system with its own sign-ins: someone
  // who can reach the MDM console can reach every tablet, whatever Phoenix says. The row names the
  // login and the role it was given, and NEVER the password.
  | "headwind_user"
  // Apps pushed to or removed from a rep's tablet from inside Phoenix (2026-09-25). A separate type
  // from the command above because it is a different kind of act: a command changes what the tablet
  // is doing for a moment, while installing or removing an app changes what the rep can do with it
  // until somebody changes it back. REQUIRED audit, written after ManageEngine has accepted the
  // change, naming the tablet by its custody asset tag and the app by its own name.
  | "manageengine_device_app"
  // An APK added to the COMPANY app repository (2026-09-25) — kept apart from the row above because
  // it reaches no tablet: it decides what the company is ABLE to send, not what any rep is carrying.
  // REQUIRED audit all the same, written after ManageEngine has created the repository entry, naming
  // the app, the file and its size. Distribution is the row above, per tablet, with its own row.
  | "manageengine_app_repository"
  // A rule set — ManageEngine calls it a profile — put on a rep's tablet or taken off it
  // (2026-09-25). This is the ManageEngine half of what the Android Management policy did: it
  // changes what the tablet is ALLOWED to do, its screen lock and kiosk pinning included, so it
  // outlives any one command and is a REQUIRED audit. The row names the tablet by its custody asset
  // tag and the rules by the name the company gave them in ManageEngine's console.
  | "manageengine_device_profile"
  // The company's rep tablet profile itself, BUILT in ManageEngine by Phoenix (2026-09-25) — the
  // rules, not who follows them. A separate type from the row above because that one records a
  // tablet being put on a rule set, while this records the rule set coming into existence with the
  // restrictions and screen lock Phoenix wrote into it. REQUIRED audit: the row carries every field
  // and value sent, which spelling of the payload name ManageEngine accepted, and whether the
  // profile was actually PUBLISHED — an unpublished profile restricts nothing, and nobody reading
  // this later should have to guess which of the two happened.
  | "manageengine_profile"
  // The ManageEngine enrollment template the Rep Tablets page renders as a QR (2026-09-25). Their
  // REST API has no enrollment endpoint at all, so the payload is copied out of the ManageEngine
  // console once and saved here; saving it is what lets any factory-fresh tablet join the fleet,
  // which is why it is a REQUIRED audit and not an ordinary settings change. The row names the
  // template and the agent package it installs — NEVER the payload, which is itself the credential.
  | "manageengine_enrollment_template"
  // Email routing. `distribution_list` is an edit to a named recipient group — who a future email
  // reaches. `company_email_alias` is the Turbify register beside it.
  //
  // TWO ENTITY TYPES, and the second is a weaker claim than the first. A distribution-list row
  // records something Phoenix DID: the rule changed, and the next send obeys it. An alias row
  // records something a person SAID — Turbify has no API, so nothing can verify who is really on
  // an alias, and "recorded 12 members" means somebody read a control panel and typed what they
  // saw. Folding them into one type would let a future reader treat the attestation as an
  // observation, which is the whole failure mode the register exists to make visible.
  //
  // Both are REQUIRED audit: an edit that silently widens who receives company mail, or a
  // membership claim nobody can be held to, is exactly what an audit trail is for.
  | "distribution_list"
  | "company_email_alias"
  // The Sato Email Composer, beside the two above. `sato_email_template` is an edit to the fixed
  // wording a seat can pick off the shelf; `sato_email_send` is one press of Send.
  //
  // TWO ENTITY TYPES for the same reason the pair above is two, and the split runs the other way
  // round: the TEMPLATE row is the stronger claim. Editing a template changes what every future
  // send says, before anything has been mailed, so it is a REQUIRED audit — refusing the edit when
  // the trail cannot be written costs nothing. A SEND row is written AFTER the mail has already
  // left, so it is best-effort: throwing there would report a completed send as a failure and
  // invite somebody to send it twice. Folding them into one type would force one of those two
  // behaviours onto the other, and each is wrong in the other's place.
  | "sato_email_template"
  | "sato_email_send"
  // A picture or file uploaded for a Sato email. Its own type because an inline picture is handed a
  // permanent public address at that moment, before any mail exists to attach it to, so the record of
  // who minted it cannot live on the send row, which may never be written.
  | "sato_email_media"
  // The CEO Email Composer, the same two shapes for the same two reasons. They are SEPARATE types
  // rather than a `composer` field on the pair above, because the whole point of reading one of
  // these trails is to answer "who sent a letter over the chief executive's name" — a question a
  // filter nobody remembers to apply would answer wrongly. The media type is deliberately NOT
  // duplicated: both composers upload into one store and keep `sato_email_media`, so the one
  // public token route stays the only anonymous address in that area.
  | "ceo_email_template"
  | "ceo_email_send"
  // Minting or revoking a bearer link to the live CV-lifecycle Google Sheet. The link outlives the
  // session that created it and copies candidate names and phone numbers out of Phoenix, so who
  // made one — and who killed it — is recorded. The token itself is never written here: an audit
  // trail that stores the credential it audits turns every reader of the log into a holder of it.
  | "cv_lifecycle_share_link"
  // CV Lookup — the search-only CV access the owner asked for on 2026-09-30, and the ONE place in
  // this system where the log is part of the feature rather than a by-product of it. He was asked
  // whether her searches should be recorded and answered yes, readable by him alone.
  //
  // TWO TYPES, because they answer different questions and neither answer contains the other:
  // `cv_lookup_search` is the term that was typed and how many people it reached — which is what
  // says whether the box is being used as a lookup or as a way to enumerate the pool — and
  // `cv_lookup_open` is one named candidate's CV and application actually leaving the building.
  // A single type would make the second unanswerable without reading the newValues of every row.
  //
  // The search row is best-effort (`writeAuditLog`): a diagnostic must never fail the search it is
  // only there to observe. The OPEN row is `writeRequiredAuditLog` — a file that carries a real
  // person's CV, phone and e-mail out of the system with no trace is treated as a failed open.
  | "cv_lookup_search"
  | "cv_lookup_open"
  | "cron_job_control"
  | "deduction_candidate"
  | "deduction_comment"
  | "deduction_decision"
  // Recording a new hire's CRM username and code from the New Hire CRM Setup tab, or ruling that
  // they need no CRM account. It is a write to the EMPLOYEE MASTER made by a role that does not
  // hold employees:update (Super Admin + SFE Manager, through canUseAdminCrmWorkspace), so who
  // changed a CRM identity is worth recording on its own. Written best-effort: the durable record
  // of who acted is crm_account_setup_tasks.resolved_by_hr_id, which the table's own CHECK refuses
  // to leave empty, so a failed audit row must not fail a save that already landed.
  | "crm_account_setup"
  | "crm_master_export"
  // The KPIs board downloaded as a workbook: every rep in the viewer's scope with his hire date.
  | "crm_kpis_export"
  // Pulling the mobile numbers behind the organogram export. The only route in the module
  // that hands back personal contact details in bulk, so who took the list is recorded.
  | "organogram_contact_export"
  // Printing business cards: every file carries a person's name, work email and mobile, and one
  // request can take up to 500 of them, so who took which cards is recorded. Not written on the
  // screen's dry run, which hands back no file.
  | "business_cards_export"
  // The bank account-opening letter: each file carries the chosen people's national IDs, mobiles,
  // addresses and base salaries, so who took which list is recorded before the file is returned.
  | "bank_account_letter_export"
  | "crm_plan_sync"
  // The Super Admin starting or stopping a TEAM's count from Phoenix CRM on every other screen (owner,
  // 2026-10-02: "Only when I start it"). Written by phoenix_crm_set_team_start itself, in the same
  // transaction as the change, so a start or a stop can never land without its row. Entity id is the
  // team's district-manager seat.
  | "crm_phoenix_team_start"
  // A manager verifying a rep's plan. The ONLY thing Phoenix writes back into the customer's CRM,
  // so who signed off which plan is recorded on our side rather than being recoverable only from
  // the vendor's system. Entity id is the CRM plan id.
  | "crm_plan_verification"
  // Daily refresh of each rep's assigned doctor list from the CRM web app. One row per run,
  // keyed on the Cairo date, naming any agent refused or failed — the two outcomes that mean
  // the mirror is older than the board claims.
  | "crm_contact_list_sync"
  | "sos_raw_template_export"
  // The Phoenix UNIVERSAL upload template (one layout, any distributor) — a different sheet from
  // `sos_raw_template_export`, which mimics one distributor's own export.
  | "sos_phoenix_template_export"
  | "deduction_export"
  | "deduction_finalization"
  | "deduction_payroll_import"
  | "deduction_payroll_preview"
  | "deduction_summary"
  | "deductions_candidate"
  | "deductions_comment"
  | "deductions_decision"
  | "deductions_publication"
  // The Daily Deductions module's running-tally snapshot (published or superseded), a separate
  // surface from the month-final "deductions_publication" above and audited on its own.
  | "daily_deductions_publication"
  | "direct_order_request"
  | "doctor_coverage_config"
  | "double_visit_import"
  | "employee_decline_offer"
  | "employee_resignation"
  | "resignation_history_export"
  | "excuse_request"
  | "field_workforce_compliance_import"
  // The hiring-document checklist. Four types because the module writes four different
  // things and "who changed the checklist" is a different question from "who filed a scan".
  // `hr_clearance_decision` and `hr_clearance_release` were written here from 2026-08-28 until the
  // Clearance & Offboarding module was removed on 2026-09-01. They are gone from this union
  // because nothing writes them any more — NOT because the rows are gone. Production `audit_logs`
  // still holds every one of them, and it should: they are the evidence trail behind settlements
  // that were released while the module was live. This union types the WRITE payload only, so
  // dropping the two names cannot hide a historical row from any reader. Do not re-add them to
  // "support" the old rows, and do not delete those rows to "finish" the removal.
  //
  // A stay discussion or an exit interview was captured. The audit row records WHO and WHICH
  // conversation, never the content: the register holds what someone said in confidence about
  // their manager and their pay, and audit_logs is read far more widely than the register is.
  | "hr_retention_conversation"
  | "hiring_document_definition"
  | "hiring_document_file"
  | "hiring_document_note"
  | "hiring_document_status"
  // What HR agreed with one joiner before their first day (2026-11-02), keyed by the offer because
  // no employee record exists yet: papers confirmed, attendance day and time, a note.
  | "hiring_joiner_contact"
  // The readiness workbook leaving the building (2026-09-29). ITS OWN TYPE rather than folded into
  // the four above, which each record one person's one document changing: this row records a FILE
  // that names many employees, their hire dates and what paperwork each of them is missing. The
  // filters are in the summary, because they are what decided who is in it.
  | "hiring_documents_export"
  // An offer of employment leaving the building. Written with `writeRequiredAuditLog`, and only
  // once mail has actually gone: it is the one action in this app that commits the company to a
  // salary in writing, to somebody who does not work here yet and so cannot be looked up in any
  // employee table afterwards. audit_logs has no CHECK on entity_type (verified against production
  // 2026-08-23, same as the note below), so this needs no migration of its own.
  | "job_offer"
  // A recruitment job post (the picture or PDF, or the full set) leaving the Job Posts page. One row per
  // download: who, the title, the design, the format and the area — the only trace of whether a post for
  // an area has already gone out. Best-effort (`writeAuditLog`): it observes a finished file and must
  // never be able to take it away. audit_logs has no CHECK on entity_type, so no migration.
  | "job_post_download"
  // A job post sent to the public careers page, or a card closed there, by a person's press (`action` in
  // the row says which, the entity id is the website's card). audit_logs has no CHECK on entity_type, so
  // no migration. Best-effort: the card already exists by the time this is written.
  | "job_post_publish"
  // The rebuilt Recruitment workspace (owner, 19–20 Oct 2026). `recruitment_candidate` is a decision
  // on one candidate from the workspace — placing them in a tab, a call result, a rejection with its
  // reason, the archive; `recruitment_candidate_answer` is HR typing an answer the applicant never
  // gave (the "added by HR" mark); `recruitment_settings` is the re-ask switch and the rejection
  // message's wording. audit_logs has no CHECK on entity_type, so no migration.
  | "recruitment_candidate"
  | "recruitment_candidate_answer"
  | "recruitment_settings"
  // A step in shutting a leaver's Turbify mailbox. Turbify publishes no email API, so Phoenix
  // cannot observe the mailbox — an audit row is the only record that a named admin claimed a
  // step was done. Written BEFORE the state changes, carrying the old values, so a later
  // reopen corrects the register without erasing what was previously asserted.
  | "mailbox_offboarding"
  // Handing a new hire's app password to Phoenix from the New Hire Mailboxes page, or ruling that
  // they need no company mailbox. The row carries the address and the outcome, NEVER the password.
  | "new_hire_mailbox"
  // 🔴 ADOPTING a mailbox that already exists — its OWN type, not a corner of `new_hire_mailbox`,
  // because it answers a different question: not "who connected a new hire's mailbox" but "who
  // RESET a working employee's, and when". That act locks the person out of webmail until a human
  // hands them the password, so it has to be findable on its own without reading every connect row
  // beside it. The dry run is audited too — asking which mailboxes WOULD be reset is itself worth a
  // record of who asked. Carries the addresses, the verdicts and the counts, NEVER the password.
  // `audit_logs.entity_type` is plain `text` with no CHECK (verified on production 2026-10-02), so
  // this needs no migration of its own.
  | "new_hire_mailbox_adoption"
  | "marketing_customer"
  // A venue merge is neither a customer nor a request change: it retires one physical place in
  // favour of another and moves every link between them. audit_logs has no CHECK on entity_type
  // (verified against production 2026-08-23), so this needs no migration of its own.
  | "marketing_pharmacy"
  | "marketing_request"
  // A change to how marketing requests are ROUTED: a control setting, a request type, or a step of
  // the approval chain. Its own type because it answers "who changed who approves what", which is
  // not a change to any one request. `audit_logs.entity_type` is plain `text`, so no migration.
  | "marketing_control"
  // Who took the Doctor-List Check or Finance Ageing as a file: doctors, reps, requesters and money leave
  // the building. `audit_logs.entity_type` is plain `text`, so no migration.
  | "marketing_finance_ageing_export"
  | "marketing_list_check_export"
  | "notification"
  | "outstation_expense_access"
  | "outstation_request"
  | "payroll_batch"
  | "permission_override"
  | "pharmacy_search_discovery"
  // Who took the Phoenix CRM reports pack, over which period, and WHETHER IT HELD THE MANAGER
  // SECTIONS. That last part is the point of the row: which sheets a workbook held IS this export's
  // access story, and a file naming individual reps and their own work leaves the building. No
  // migration — audit_logs has no CHECK on entity_type.
  | "phoenix_crm_reports_export"
  // Who downloaded a Visit report workbook (2026-10-15), over which rep or district and period. The Super
  // Admin and the SFE Manager only; no migration — audit_logs has no CHECK on entity_type.
  | "phoenix_crm_visit_report_export"
  // Who opened a Visit report ON SCREEN (2026-10-16), over which rep or district, period and how many
  // fields. A row of its own and not the export's: the screen shows where named people's phones were just
  // as the file does, and until this type existed the access registry declared the read audited while
  // nothing wrote a row (0 on production). Best-effort, as the export's is. No migration.
  | "phoenix_crm_visit_report_view"
  // A Visit report saved view saved or deleted (2026-10-16): the owner's own named choice of fields, nothing
  // else. Recorded because the access registry declares the route audited. No migration.
  | "phoenix_crm_visit_report_saved_view"
  // Who opened the CV of an interview recorded on a Phoenix CRM Interviews day (2026-10-29): a candidate's
  // CV leaving the building, so the route is declared an export audit in the access registry. No migration.
  | "phoenix_crm_day_interview_cv"
  // Who downloaded the location-integrity board, and how much of it (2026-10-13). ITS OWN TYPE and
  // not folded into the reports pack above, because what leaves the building here is different in
  // kind: the evidence a named rep's capture was questioned, which Phoenix CRM never shows that rep.
  // "Who took that, and how many cases of it" has to stay answerable without reading every export
  // row ever written. Best-effort audit, as the reports pack is — a download is a read, and a logging
  // failure must not refuse a reader the board he is allowed on. No migration: audit_logs has no
  // CHECK on entity_type.
  | "phoenix_crm_integrity_export"
  // The SFE's customer-list template, both ways, with the territory as the entity id (2026-10-02). The
  // download carries a territory's customers and their grades out of the building; the import writes a
  // whole list at once, with the grades the SFE set, which on the ordinary path is the district
  // manager's decision and SFE's approval taken one customer at a time. Who did that, and to which
  // territory, is the row. No migration — audit_logs has no CHECK on entity_type.
  | "phoenix_crm_list_template"
  | "phoenix_crm_list_template_import"
  // Who pulled the shared Planning Calendar to XLSX, for which month. Gated to SFE
  // Manager / Super Admin; the month is the entity id so a row says WHICH period
  // was handed over. audit_logs has no CHECK on entity_type, so this needs no migration.
  | "planning_calendar_export"
  | "private_calendar_data_dispute"
  | "probation_case"
  | "probation_config"
  | "probation_decision"
  | "probation_dv_day"
  | "probation_feedback"
  | "probation_assessment"
  | "probation_development_action"
  | "salary_flag"
  | "sales_import_batch"
  | "source_of_sales_area"
  | "source_of_sales_block"
  | "source_of_sales_brick"
  | "source_of_sales_distributor"
  | "source_of_sales_product"
  | "source_of_sales_region"
  | "territory_preview_link"
  | "territory_sync"
  // A scheduled job that stopped reporting, or reported failure, as found by the job
  // heartbeat sweep. Written only when something is wrong: a row every 15 minutes saying
  // "all fine" would bury the log in 96 entries a day and hide the real ones.
  | "scheduled_job_health"
  // Added 2026-10-23 with /admin/system-audit (Super Admin only): a status change on an audit issue,
  // one occurrence marked no-defect / unknown, and every export (who, the filters, the row count).
  | "system_audit_status"
  | "system_audit_triage"
  | "system_audit_export"
  // Who opened which screenshot on /admin/system-audit, whose screen it was, and when it was taken
  // (owner, 23 Oct 2026: "log every screenshot view"). Both pictures are unmasked by his choice, so a
  // look at one is a read of whatever was on that person's screen. Written before the picture leaves
  // (src/lib/system-audit/screenshot-views.ts). `audit_logs.entity_type` is plain `text`: no migration.
  | "system_audit_screenshot_view"
  | "system_cleanup"
  | "user"
  | "user_activity_access"
  // The Company Activity Report export (day-by-day CRM/attendance/leave, not payroll). Named with
  // the "company_" prefix on purpose — "activity_report" alone would sit too close to
  // user_activity_access above, a different and unrelated concept.
  | "company_activity_report_export"
  | "vacation_report_export"
  | "vacation_request"
  | "vacation_retention_purge"
  | "vacation_weekly_off_policy"
  // Visual Aids (2026-09-18): a flyer uploaded, retired, or replaced by a newer version. REQUIRED —
  // what a rep holds up in front of a doctor is promotional material for a prescription medicine,
  // so who put it there and who took it down must never be a blank.
  // The Production Planner (2026-10-05): the raw-material plan for the products EGPI
  // toll-manufactures for us. A PRICE is REQUIRED — an unrecorded price change is how an order
  // cost moves with nobody able to say who moved it — and so are a committed plan, a recorded run
  // and a change to who holds the module. The formula, the stock reports and the settings are
  // ordinary rows: they are reversible and the table keeps its own history.
  | "production_material"
  | "production_material_price"
  | "production_plan"
  // Medical insurance (owner, 2026-11-04). The member, exception, invoice and document rows are REQUIRED:
  // who is on a policy decides who is covered and what is billed. The export row is best-effort, as every
  // export's is, and names what left the building.
  | "medical_insurance_document"
  | "medical_insurance_exception"
  | "medical_insurance_export"
  | "medical_insurance_invoice"
  | "medical_insurance_member"
  | "production_planning_access_grant"
  | "production_planning_settings"
  | "production_run"
  | "production_stock_entry"
  | "visual_aid"
  | "weekly_plan"
  // A weekly sales upload deleted or re-tagged: the only record of who did it and which upload it was.
  | "weekly_sales_batch"
  | "weekly_sales_mapping"
  | "weekly_plan_day"
  // The WhatsApp Inbox (Super Admin only): a message sent from Phoenix on a company number, a chat
  // linked to a candidate or employee, and an attachment saved into a candidate's files. Each speaks
  // for the company or moves a person's documents, so each is a required row.
  | "whatsapp_inbox_conversation"
  | "whatsapp_inbox_message"
  | "workflow_registry";

export type AuditLogInput = {
  actorLoginId?: string | null;
  entityId?: string | null;
  entityType: AuditEntityType;
  newValues?: Record<string, unknown> | null;
  oldValues?: Record<string, unknown> | null;
  summary: string;
};

export class AuditPersistenceError extends Error {
  cause: unknown;

  constructor(cause: unknown) {
    super("Critical audit log could not be persisted. Review mutation state before retrying.");
    this.name = "AuditPersistenceError";
    this.cause = cause;
  }
}

export type AuditLogFilter = {
  actor?: string | null;
  action?: string | null;
  entityType?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  page?: number;
  pageSize?: number;
};

export type FullAuditLogRow = {
  id: string;
  actorHrId: string | null;
  actorLoginId: string;
  actorRole: string | null;
  entityId: string | null;
  entityType: string | null;
  summary: string | null;
  requestIp: string | null;
  createdAt: string;
};

export type AuditLogPage = {
  logs: FullAuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export async function getAuditLogs(filter: AuditLogFilter = {}): Promise<AuditLogPage> {
  return getOperationalAuditLogs(filter);
}

/**
 * Fast attempt, then ONE slower retry, then the outbox. Returns the error that ended it, or null.
 *
 * The bounded first attempt is what keeps the audit trail off the critical path of a request, and
 * it stays — `OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS`, raised from 3s to 8s on 26 Oct 2026 because the
 * client's own round trip on production runs a p95 of 3.5s and 3s was aborting ordinary writes.
 * What changed on 23 Oct 2026 is what happens when it expires: it used to be a log line
 * and a lost row — 109 of them in 21 days, 40 inside the three hours when production Postgres
 * restarted four times. The mechanism, including the probe that stops a blind retry writing the
 * row twice, is `src/lib/platform/write-outbox.ts`; the `audit_logs` half of it is
 * `src/lib/admin/audit-outbox.ts`. Owner's instruction: "both, plus never lose a row".
 */
const persistAuditLog = persistAuditLogThroughOutbox;

export async function writeAuditLog(input: AuditLogInput) {
  const error = await persistAuditLog(input);
  if (error) {
    // ONE line, not two. Until 23 Oct 2026 this logged the same failure twice, and the second call
    // never reached `app_error_events` at all: `persistErrorEvent` was holding a module-wide
    // re-entrancy flag that any in-flight persist closed the door with. That flag now blocks only
    // the error monitor's own two self-reports, so a second line here would be a second ROW.
    logError("Audit log could not be persisted", {
      labels: { event: "audit_persistence_failed", entityType: input.entityType, entityId: input.entityId ?? null },
      context: { actorLoginId: input.actorLoginId ?? null, summary: input.summary },
      error,
    });
  }
}

export async function writeRequiredAuditLog(input: AuditLogInput) {
  const error = await persistAuditLog(input);
  if (error) {
    // Critical: a required audit row could not be written. Page this loudly.
    logError("Critical audit log could not be persisted", {
      labels: { event: "critical_audit_persistence_failed", entityType: input.entityType, entityId: input.entityId ?? null },
      context: { actorLoginId: input.actorLoginId ?? null, summary: input.summary },
      error,
    });
    // Still thrown, even though the row is now queued. These callers treat an unwritten audit row
    // as a failed act and decide for themselves what to do about it; the queue stops the row being
    // LOST, and deliberately does not quieten the alarm that says it was not written in time.
    throw new AuditPersistenceError(error);
  }
}
