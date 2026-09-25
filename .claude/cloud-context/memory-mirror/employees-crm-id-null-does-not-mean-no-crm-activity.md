---
name: employees-crm-id-null-does-not-mean-no-crm-activity
description: "A NULL employees.crm_id does NOT mean the person logs no CRM visits — the mirror resolves agent_hr_id at sync time; matching on crm_id silently returns zero rows"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2d66b5e6-1a1a-44ee-8e95-86506c216715
  modified: 2026-08-05T16:06:25.720Z
---

`ireports360_visits` carries BOTH `agent_crm_id` and a sync-time-resolved `agent_hr_id`. An employee
whose roster `employees.crm_id` is **NULL** can still have hundreds of visits, matched by
`agent_hr_id`.

**Never count someone's CRM activity with `v.agent_crm_id::text = e.crm_id::text`.** When `crm_id`
is NULL that predicate is never true, so the query returns **0 rows** — and zero reads exactly like
"this person never logs visits". It is a null-comparison artefact, not evidence.

Match on `agent_hr_id` (or on both), e.g.
`where v.agent_hr_id ilike e.hr_id or v.agent_crm_id::text = e.crm_id::text`.

**Why:** 2026-08-05. B-112 (Gerges Sameh) was flagged for one no-CRM-activity day, 451.61 EGP.
A crm_id-based count returned 0, which was read as "he has no CRM account and could never log" —
and the deduction was cleared on that reasoning. Matched on `agent_hr_id` he had **154 visits in
July**, just none on the charged day. He is one of the heaviest CRM users in the data. The
clearance was wrong and had to be reinstated.

Cross-check before concluding: 7 live July CRM candidates belonged to employees with NULL `crm_id`,
and every one of them had real visits by hr-id (26 to 154). **NULL crm_id is common and means
nothing about activity.**

**How to apply:** the zero-CRM-signal exclusion (`computeZeroCrmSignalKeys`, `src/lib/deductions/
connectors/crm.ts`) already does this correctly — it builds `activeHrKeys` from `agent_hr_id` AND
`activeCrmIds` from `agent_crm_id`, and treats either as signal. Ad-hoc SQL written to review a
candidate must do the same, or it will manufacture the exact "data-mapping gap" story the guard
exists to detect — and argue for clearing a legitimate deduction. Related:
[[never-auto-publish-deductions-owner-confirms-first]].
