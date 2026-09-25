---
name: probation-email-no-data-token-gap
description: "Whole CLASS of system emails went out blank — admin-edited templates use tokens the code never supplied; fix = templateContext. PR #400 fixed 7 templates."
metadata: 
  node_type: memory
  type: project
  originSessionId: f1912edc-c8c9-4f2f-aa00-27ae4ddd1c39
---

The daily automated **probation reminder email** (cron → `processDueProbationReminderEvents` in `src/lib/probation/service.ts`) was being sent with **no data** — Line/Position/Area/Hire Date/Probation End Date/Time Remaining rows all blank, greeting `Dear ,`.

**This is a whole bug CLASS, not just probation.** PR #400 audited every live template and fixed 7: probation_reminder, probation_workflow, contract_renewal (reminder cron), resignation_workflow, leave_approval, leave_rejection, excuse_request. Verified-clean (no change): leave_request, contract_renewal (workflow send), interview_feedback/invitation, offer, password_reset/setup, user_created, birthday, general, coaching_report. Follow-ups: `general_hr` is an orphan DB row with a `{{body}}` token the renderer can't resolve (never sent — safe to delete from `email_templates`); the excuse employee-decision email reuses the manager-oriented excuse_request template (needs its own employee template — task_bbdbea49).

**Root cause:** On 2026-06-19 the `probation_reminder` and `probation_workflow` templates were redesigned in `/admin/email-templates` (DB table `email_templates`) into detail tables whose cells use tokens `{{line}} {{jobTitle}} {{area}} {{hireDate}} {{endDate}} {{duration}} {{managerName}}`. The probation notification code only sent 3 metrics (Employee, Hire date, Days remaining) and set `startDate` (not `hireDate`). The generic metric→context mapping in `src/lib/notifications/email.ts` (`migratedTemplateKeyForNotification` → `sendTemplatedEmail`) never populated the new tokens, so every new cell rendered empty.

**Fix (PR #400, branch codex/probation-email-no-data-fix):** the domain supplies an explicit `email.templateContext` carrying the exact tokens each template uses. `templateContext` is spread LAST into the render context (`sendNotificationEmailDirect`), so it authoritatively fills tokens.

**Why:** admin-editable email templates can introduce tokens the calling domain code doesn't know about; nothing validates that the domain supplies every token a template references → silent blank cells.

**How to apply:** when an `/admin/email-templates` template is edited to add new `{{tokens}}`, make sure the domain caller passes them via `email.templateContext` (keys must match `EmailTemplateContext` fields). Don't rely only on `metrics` — those map to a fixed subset. Verify by rendering the live template through `renderEmailTemplate` with the real context. Related: [[email-template-unification]], [[marketing-email-editable-tokens]], [[weekly-plan-approvals-in-action-center]].
