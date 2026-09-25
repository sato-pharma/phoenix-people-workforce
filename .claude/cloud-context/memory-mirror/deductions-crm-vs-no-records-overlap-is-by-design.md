---
name: deductions-crm-vs-no-records-overlap-is-by-design
description: "crm and no_records_activity BOTH flagging the same absence day is intended — it is surfaced as a warning and hard-blocks publish, not a silent double-charge"
metadata: 
  node_type: memory
  type: project
  originSessionId: 78db7cee-29fb-4521-b842-dc76f3d165f6
  modified: 2026-08-01T22:34:48.156Z
---

**Both connectors are meant to run.** `service.ts:533`: *"Three detectors noticing
the same absence day is expected and reviewable — aborting the collection run
over it would be wrong."* They differ deliberately:

| | `crm` | `no_records_activity` |
| --- | --- | --- |
| Population | field workforce only | **every active employee** |
| Adjudication | automatic | **HR-adjudicated per day, never automatic** |
| Engine | FWC recommendations | Private Calendar `getCompanyNoActivityDays` |

**The overlap is NOT silent.** Collection pushes a warning per collision
(`service.ts:539-553`, display capped at 20 + an "…and N more" line), and
`publishMonth` **hard-blocks**: `findDayCollisions(eligible)` at
`publish.ts:110`. Crucially it runs against **eligible** candidates only —
*"an overlapping day that HR already cleared in one category is resolved, not a
conflict."* A DB trigger backstops the publication row itself. So overlapping
money can never reach a payslip; it stops the month instead.

**Measured on July 2026 production (after the 2026-08-01 re-collect):**
crm + no_records_activity **142 employee-days / 50 employees** · crm +
fingerprint 7 / 1 (Nahed Hattab) · crm + unpaid_vacation 1 / 1. All 150 need HR
to clear one side before July can publish.

## 🔴 Two mistakes I made reading this — do not repeat

1. **"The detector said nothing about crm + no_records."** It did. The connector
   reported 21 warnings, which is exactly the cap (20 collisions + 1 "…and N
   more"). I had truncated my own script's output to 5 lines and read the
   absence as evidence. **A capped list is not a complete list.**
2. **"109,951.66 EGP of double-charging."** Wrong framing — publish is blocked,
   so nothing is charged. It is 142 adjudication items, not an over-billing.

## 🔴 The zero-signal guard counts DOUBLE-VISIT tags as signal

`loadZeroCrmSignalHrIdKeys` (`crm.ts:379`) builds its signal set from
`agent_hr_id`/`agent_crm_id` **and** `double_hr_id`/`double_crm_id`. So a
manager who never logs a visit but is TAGGED on rep visits has signal and stays
in scope. Verified July 2026:

- **Hossam AboElftouh (A-9)**, Marketing Manager, crm_id 1193 — 0 as agent,
  **0 as double** ⇒ zero signal ⇒ correctly excluded (his 30,967.74 is gone).
- **Rasha Sabry (A-8)**, Group Product Manager, crm_id 1185 — 0 as agent,
  **21 visits across 4 days as the tagged double** ⇒ has signal ⇒ still flagged
  for her other 16 days at **22,193.55 EGP**.

**#1584's own doc comment (`crm.ts:327`) is factually wrong**: it states A-8 had
*"0 CRM rows all month"*. She had 21. That PR could only ever fix A-9's
30,967.74 — **the "53,161 EGP" figure was never fully in scope**, and I repeated
it to the owner three times before checking. My verification query only read
`agent_crm_id`, reproducing the exact blind spot that created the claim.
**When confirming a claim, do not reuse the lens that produced it.**

Consequence of the binary rule: one tagged visit is the difference between
"excluded entirely" and "billed for the whole rest of the month". Whether that
cliff is right is an owner decision, not a bug. See
[[dv-checkin-attribution-managers-borrow-rep-checkin]] for why managers only
ever appear as the tagged double.
