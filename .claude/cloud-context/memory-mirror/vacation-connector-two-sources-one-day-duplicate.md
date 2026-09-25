---
name: vacation-connector-two-sources-one-day-duplicate
description: "collectUnpaidVacationCandidates has two sources that can both claim one employee-day; the dedup guard is one-directional, so re-running it on a month that already has CRM-signal rows creates duplicates."
metadata: 
  node_type: memory
  type: project
  originSessionId: e82cba75-723e-4bcf-8f49-e265c1e2b4bb
  modified: 2026-08-03T21:54:13.709Z
---

`collectUnpaidVacationCandidates` emits from **two** sources with different key prefixes:

- `crm_vacation_signal` — key `crm-vacation:{HR_ID}:{DATE}:{category}`
- `vacation_balance` — key `vacation:{requestUuid}:{category}`

Same employee, same day, same category, **different candidate_key**. The unique index is
`(category, candidate_key) WHERE superseded_at IS NULL`, so it cannot see the collision, and the
insert-time duplicate probe matches on key — so it does not either. Only `findDayCollisions` catches
it, at publish, by refusing the whole month.

**The guard is one-directional.** The CRM path skips a day an HR request covers (`if (covered)
continue`). The HR-request path has no matching check, so it will happily create a row for a day a
`crm_vacation_signal` candidate already claims from an earlier run.

**How it bites:** re-running `unpaid_vacation` for a month that already has CRM-signal candidates.
On 2026-08-03 this produced **23 rows created when 7 were expected** and **13 duplicate
employee-days** in July 2026 (live count 119 → 135, total → 107,477.66 EGP). All withdrawn; July
restored to 119 / 101,953.44 EGP. Nothing was published.

**Do not misdiagnose it as key instability.** The trailing hash is identical on both rows
(`…:c59d6676` on each) — only the SOURCE PREFIX differs. I wrongly blamed my own edit for changing
the key; the restore's unique-index violation was the disproof, because it showed the key was
byte-identical. See [[prove-it-fails-verify-which-assertion-fired]] for the same class of error.

**How to apply:**
- Before re-running `unpaid_vacation` on a month that already holds candidates, expect duplicates.
  Run the employee-day audit first: expand `dates` with `jsonb_array_elements` and group by
  (`employee_hr_id_compact`, day) having count > 1.
- The fix is a reverse guard: the HR-request path must skip an employee-day already claimed by a
  live candidate, mirroring `if (covered) continue`. Same ledger-check pattern the
  `dsm_no_record` and `holiday_bridge` connectors already use.
- **Recreating a superseded candidate is order-sensitive.** The partial unique index forbids the
  original and its recreation being live at once — withdraw the new row BEFORE un-superseding the
  old, or the update fails with 23505.

Related: [[deductions-module-god-mode]], [[deductions-crm-vs-no-records-overlap-is-by-design]].
