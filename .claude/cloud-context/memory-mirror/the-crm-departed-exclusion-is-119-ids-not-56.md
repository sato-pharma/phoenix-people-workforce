---
name: the-crm-departed-exclusion-is-119-ids-not-56
description: "The effective CRM departed-agent exclusion is 119 crm ids (71 static + 56 live, overlapping by 8) — \"56\" is the LIVE TIER ALONE and was published as the whole exclusion; and the double-visit defect charged 12 days across 6 people, not 11, because a day belonging to someone who has SINCE resigned drops out of an \"active people\" count while its undecided deduction does not."
metadata:
  node_type: memory
  type: project
  originSessionId: 09976a7d-dce2-490f-8f9d-b61bf151e220
  modified: 2026-10-07T20:29:18.626Z
---

Measured on production 2026-10-07, after shipping [[sos-monthly-closing-is-the-only-sales-truth]]'s
neighbour fix — the departed-partner read door (`.claude/rules/crm.md`, "THE DEPARTED-AGENT
EXCLUSION IS KEYED ON WHO *LOGGED* THE ROW").

**The exclusion has two tiers and they are different sizes.** `CRM_RESIGNED_AGENT_CRM_IDS` in
`src/lib/crm/reads.ts` is **71** hand-maintained ids; the live tier (`scanDepartedAgentCrmIds` →
`resolveLiveDepartedExclusion`) is **56**; the union is **119** (they overlap by 8). A session that
measures only the live tier and reports it as "currently excluded" understates the exclusion by
more than half. PR 5447's body said 56 and was corrected after the merge.

**Reproducing the exclusion in SQL: join on the MIRROR's `agent_hr_id`, never `employees.crm_id`.**
The live tier matches `ireports360_visits.agent_hr_id` against employees whose
`employment_status` ∉ {`active`, `on_leave`}, then drops any id an active employee currently owns
(the handed-over-slot carve-out). A query that joins `employees.crm_id = v.agent_crm_id` instead
returns **zero** departed loggers and reads as a clean bill of health — only 117 of 208 employee
rows carry a crm_id at all, and a leaver's is typically not among them.

**Why the charged-day count moved from 11 to 12.** The "100 person-days erased across 18 people"
measure is scoped to people who are **still active**, which is right for "who is being wronged
today". The money list must not be: Yehya Mohamed Kamal eldeen Saad Mohamed (B-23) resigned
2026-08-31, so he left the active measure, but his 21 July day — 10 real visits, logged by a
departed rep — is still an **undecided 1,000.00 EGP deduction**. Counting the two measures the same
way lost one day and 1,000.00 EGP. **State which population a figure is scoped to, and never reuse
an "active employees" count as the money total.**

Correct as of 2026-10-07: 12 charged days across 6 people — 2 approved (both Salim Salim Abdo
Ibrahim Gomaa, 7 and 13 September) and **10 still pending, 5 people, 8,616.13 EGP, 74 real visits,
every one of the 10 days having lost 100% of its evidence.**
