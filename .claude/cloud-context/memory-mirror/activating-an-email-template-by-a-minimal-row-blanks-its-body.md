---
name: activating-an-email-template-by-a-minimal-row-blanks-its-body
description: "activating an email template with a minimal `email_templates` row SILENTLY replaces its shipped content - `mapTemplate` falls back only on NULL (`row?.body_html ?? fallback.bodyHtml`) and every content column in that table is NOT NULL with a placeholder default, so an insert naming only template_key + is_active sends `Body content is not configured yet.` to the real recipients. Write every content field from the code default, or publish through the Email Templates screen. The RECIPIENTS are safe either way: they live in a SEPARATE table, `email_template_recipient_rules`, so that table having no row is what keeps the code's own routing - and conversely a row there with empty arrays would mail nobody while the template looks active."
metadata:
  node_type: memory
  type: project
---

Found on 2026-10-06 arming the Production Planner's reorder alarm, before anything was written.

**The merge is null-tolerant, the table is not.** `src/lib/email-templates/service.ts` `mapTemplate`
reads `row?.body_html ?? fallback.bodyHtml` for every field, so the intention is clearly "a row
overrides what it states and inherits the rest". But `email_templates` declares `description`,
`subject`, `greeting`, `body_html`, `body_text`, `closing`, `closing_text` and `preview_text` all
`NOT NULL` **with defaults** - `body_html` defaults to `'<p>Body content is not configured yet.</p>'`.
So the inherited path is unreachable: a row always carries a non-null value, and a minimal insert
publishes the placeholder as the live body.

**So activating one by SQL means writing every content field from `templateDefaults`.** That is what
was done for `production_planning_reorder`, then read back field by field against the code.

**Two further details of that table worth keeping.** `closing` and `closing_text` both exist and
only `closing_text` is read. `smart_greeting` is `NOT NULL default true` and is read NOWHERE in
`src/lib`, so it cannot rewrite an Arabic greeting - checked rather than assumed.

**The four switches are genuinely independent, and only one of them is code.** `prodplan_settings`
`alarm_enabled` / `alarm_dry_run`, the template's `is_active`, and `EMAIL_NOTIFICATIONS_ENABLED`.
The last one was already on and can be proven from data instead of Railway: `notification_outbox`
held 400 `sent` rows in seven days, newest minutes earlier.

**Arming is a REQUIRED audit event.** `updateSettings` switches to `writeRequiredAuditLog` when
either arming flag changes, so an arming done in SQL writes that row by hand - `audit_logs`,
`entity_type` `production_planning_settings`, `entity_id` `1`.

Related: [[never-fire-bulk-emails-ever]] - [[every-automated-email-also-mirrors-to-the-admin-telegram]]
