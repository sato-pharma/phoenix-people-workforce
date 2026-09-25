---
name: telegram-template-unification
description: "Telegram templates page is now the source of truth for automated Telegram sends: module-wide '*' matching + {{title}}/{{message}} content placeholders + 7-card catalog + delivery-safety hardening. SHIPPED to prod 2026-06-10 via PR #124 (merge dceb2a5), verified live."
metadata: 
  node_type: memory
  type: project
  originSessionId: f5928463-344b-43fd-a57b-21cfc3d21a40
---

User demand (2026-06-10, after the email unification shipped): same one-source-of-truth treatment for Telegram — "when i edit a template automatic updates and sends".

**Audit (wf_ea5ad1d5-968, 43 agents):** only 3 of ~27 live Telegram sends matched the editor. Root cause: notification_templates matches EXACT (module, event_type, channel) and the editor seeded only 8 combos, several keyed to event names that never fire plus pure phantoms (birthdays/anniversary/payslip). Prod had only 2 saved rows → clean slate.

**Build:** templates.ts: loadTemplate selects `.in("event_type", [eventType, "*"])`; exported pure `selectTemplateRow` (exact active > active "*" > null). {{title}}/{{message}} = the channel-composed wording, ALWAYS (direct-first precedence). telegram-templates.ts: 7 cards — vacation/outstation/weekly_plans/marketing_requests/contract_renewal/probation/general_admin_test, all eventType "*" with identity defaults. No migration: behavior changes ONLY when a card is saved. DELIVERY SAFETY (19-agent review, all fixed): (1) degrade-to-buttonless on bad saved buttons; (2) quiet-hours try/catch; (3) save-time dry-render; (4) stale-row guard; (5) genericOnly title+buttons strip (GENERIC_NOTIFICATION_TITLE); (6) UI scope note on "*" cards.

SHIPPED to prod 2026-06-10 via [PR #124](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/124) (commit 8af0d8b → merge dceb2a5), production deploy verified live (/admin/notifications/telegram/templates HTTP 200). No migration, no env change. Worktree + branch cleaned up.

Related: [[email-template-unification]] (same pattern for email channel, shipped earlier same session via PR #119).
