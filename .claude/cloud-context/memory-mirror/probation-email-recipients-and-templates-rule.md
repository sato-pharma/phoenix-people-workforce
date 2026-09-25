---
name: probation-email-recipients-and-templates-rule
description: "For probation (and generally) emails — ASK the owner who receives each email before wiring recipients; every new email template MUST be registered in the admin email-template engine, never hardcoded"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8c826290-3610-4c5c-80f9-d84104d12c1c
---

**Email-render gotcha (prod incident 2026-07-14, fixed PR #1062):** a new email template token must be added to BOTH the `EmailTemplateContext` type AND the render allowlist `placeholderHints` in `src/lib/email-templates/service.ts` — the renderer strips any non-allowlisted `{{token}}` to EMPTY. P9 added the probation tokens (dvDate, evaluatorName, visitCount, dvProgress, provisionalScore, riskStatus, probationDay, daysRemaining, milestoneDay) only to the type, so DV-snapshot + milestone emails went out with blank fields at go-live. Tests that only assert the TYPE won't catch this — assert the tokens are in the allowlist. **Instant pause lever (no deploy):** set `email_notification_policies.enabled=false` for a `notification_type` (probation emails use notificationType 'probation'); delivery reads it at send time. Re-enable after.

Owner directive (2026-07-13), during the Probation Decision Intelligence rebuild (PR #1041):

1. **Ask before setting recipients.** Before wiring the recipient list for ANY email
   (DV-Day snapshot, Day 30/60/75 milestones, SLA reminders/escalations, decision
   notifications, etc.), STOP and ask the owner exactly who should receive that specific
   email. Do not assume recipients from the hierarchy or the spec.

2. **New templates go in the email-template engine.** Every new email template must be
   added to the admin-editable engine (`src/lib/email-templates/service.ts` →
   `EMAIL_TEMPLATE_KEYS`, `templateDefaults`, `defaultRules`, `EmailTemplateContext`
   tokens) and the `email_templates` table — NOT hardcoded inline in a notification call.
   This keeps every email editable by admins and consistent with the existing
   probation_reminder / probation_workflow templates.

**Confirmed recipient matrix (2026-07-13, Phase 9):**
- DV-Day snapshot (after each validated DV Day): CEO + HR + SFE Manager + DM + NSM + TM +
  PM/GPM (line-matched) + the evaluator who did the DV.
- Day 30 / 60 / 75 milestones: CEO + HR + DM + NSM + SFE Manager (CEO on ALL emails).
- Phase-4 SLA feedback reminders: unchanged — feedback due → evaluator only; escalated/
  overdue → evaluator + HR.

**Why:** the owner controls who gets probation communications (sensitive HR content) and
wants all templates centrally editable, not scattered in code.

**How to apply:** in Phase 9 (Email & Milestone Communications) and any future email work,
(a) present the proposed recipient set per email and get explicit confirmation, and
(b) register template keys + default recipient rules in the template engine, then emit via
`createSystemNotification` referencing the template key. Relates to
[[email-template-unification]] (templates ARE the engine) and
[[probation-module-is-field-force-only]].
