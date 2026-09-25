---
name: amira-samy-crm-identity-cn-0005
description: "Amira.Samy (French Line / C) CRM agent maps to HR_ID CN-0005 — owner-provided fix for the unmapped-agent CRM issue."
metadata: 
  node_type: memory
  type: project
  originSessionId: 76130c78-51c5-4485-975a-3e70161783c6
---

Owner confirmed (2026-07-17): **Amira.Samy ( French Line / C )** = HR_ID **CN-0005**. Her iReports360 CRM agent (agent_crm_id **1543**, per [[visits-checkins-accuracy-audit-2026-07-12]]) was unmapped, so her visits show `agent_hr_id = null` and surface in the CRM Issues tab as "Agent unmapped".

Fix = add the crm_id → hr_id override (1543 → CN-0005) so the identity waterfall (`src/lib/crm/identity.ts`, order: override › crm_id › unique username) resolves her. Apply via the same override the visits-report resolve-identity flow uses. Applies per-database (staging vs production are separate).
