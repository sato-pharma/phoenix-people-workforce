---
name: hire-date-history-survives-only-in-probation-reminders
description: "employees.hire_date keeps no history and its saves leave no audit row, so the only trace of an earlier value is metadata.hire_date on cancelled probation reminders, Medical Reps only. A date moved away and back leaves that person with no live reminders."
metadata:
  node_type: memory
  type: project
  originSessionId: e50549d1-2c7d-48f2-9380-f5c0f14ffe8c
  modified: 2026-11-03T11:03:04.265Z
---

Measured on production, 2026-11-03, after the owner said HR found a Master hire date wrong and corrected it.

A save of `employees.hire_date` (`POST employees?on_conflict=hr_id`, from HR Forms' facts or the Employee Master) writes no `audit_logs` row, `employee_history` holds nothing for these people, and the edge log has no request body. The one surviving trace is `notification_events.metadata->>'hire_date'` on `event_key like '%:probation:%'` rows, which `trg_probation_reanchor_on_hire_date` cancels when the date moves. Probation cases and reminders exist only for titles containing "medical rep", so a District Manager's change leaves no trace at all, and a change undone between reminder runs may leave none.

Mohamed Salah's proof (2 Nov, Cairo): writes at 14:28:34 and 14:35:16 line up with reminders cancelled at 14:28 and 14:35, and the middle set carries hire date 2 Nov against a letter of 25 Oct.

**The round trip loses reminders:** the dedupe key embeds the date and the upsert uses `ignoreDuplicates`, so returning to the original date meets its own cancelled rows and creates nothing. Mohamed Salah had 0 live reminders on 3 Nov, the only active probation case in that state.

**How to apply:** when asked what a hire date used to be, read those rows and say a person outside Medical Reps cannot be answered from the data. Comparing the letter with today's Master cannot see a mismatch that was already corrected. Related: [[hire-date-change-doubles-probation-reminders]], [[au-occupancy-hiring-date-from-master]].
