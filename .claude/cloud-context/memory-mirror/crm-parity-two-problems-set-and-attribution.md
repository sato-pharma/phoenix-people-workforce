---
name: crm-parity-two-problems-set-and-attribution
description: "SHIPPED 2026-08-29 & self-healing in production: the Phoenix CRM↔iReports360 parity guarantee is BUILT and RUNNING — pre-hire hire_date attribution guard (identity.ts, #2504→#2539) and a daily full-history parity sweep (parity.ts, #2504). This file is the historical 2026-08-28 analysis of the two defects they fixed (row-set parity + pre-hire attribution). Do NOT re-implement — read the code first"
metadata: 
  node_type: memory
  type: project
  originSessionId: ef7991ee-50e2-4d24-abe4-51291be48b6c
  modified: 2026-10-01T00:00:00.000Z
---

## ✅ STATUS — SHIPPED & RUNNING IN PRODUCTION (verified 2026-08-29)

**Both defects below are FIXED and live on `main`. Do NOT re-implement — read the code first (a
session almost rebuilt this from the stale note on 2026-08-29; the live code caught it).**

- **Problem 2 (pre-hire attribution) — LIVE.** `isAttributableOn` (`src/lib/crm/identity.ts`)
  now refuses any row dated before the employee's `hire_date`
  (`if (hireDate && visitDay < hireDate) return false`), backed by `hireDateByHrId` in the identity
  maps, `blockReasonFor` (pre_hire vs post_exit counted apart), an employment-scoped manual override,
  and a save-time `findPreHireMappingConflict` in `admin.ts`. Shipped PRs #2504 → #2517 → #2531 → #2539.
- **Problem 1 (row-set parity) — LIVE.** `src/lib/crm/parity.ts` (`runIReports360ParitySweep`) is the
  full-history sweep exactly as proposed below: 30-day window slicing (`resolveParityWindows`), id-set
  compare (`compareVisitIdSets`), "last proven equal" stored in `ireports360_parity_windows`, a
  staleness alarm (`PARITY_STALE_AFTER_DAYS`), and `decideParityAction`'s refuse-on-suspicious-fetch
  data-safety guard (empty answer / >50% shortfall). Wired into `live-poller.ts` as `parity-sweep`,
  runs **daily ~02:00 Cairo**, lowest priority. Shipped PR #2504.
- **Production evidence (queried 2026-08-29):** sweep running — last window verified 02:27 Cairo;
  migration applied; **0 windows stale, 0 refused**; ~2 of ~8 history windows swept and repairing
  (found 221 extra mirror rows the CRM no longer holds, 0 missing). Mid its first rotation, one 30-day
  window per day by design, so full history is re-proven every ~8 days at flat cost.

Everything below is the 2026-08-28 record of the defects and the plan — kept for the WHY, not as open
work. See [[pre-hire-blocks-will-alarm-when-a-reconcile-reaches-january]] and
[[crm-resigned-slot-reused-for-new-hire]].

**OWNER GOLDEN GOAL, 2026-08-28:** *"these two modules must be a hundred percent identical in
numbers… a rep in the CRM did nine visits and the same rep in the same days in this module made
eight. Never never never. Go and find how to guarantee this."* Phoenix's CRM module must equal
iReports360 exactly. Treat any drift as a defect, never as an acceptable trade.

**Measured live 2026-08-28 by a read-only parity probe (scratchpad `crm-parity-probe.mjs`): the
drift is real, and it is TWO unrelated problems. Do not conflate them — a fix for one does nothing
for the other.**

## Problem 1 — row-set parity (509 rows wrong of 126,547)

Per-month CRM-vs-mirror id-set comparison, all of 2026: Jan 145 extra · Feb 76 extra · Mar 64 extra
· Apr 5 extra · May **32 missing + 183 extra** · Jun 0 · Jul 0 · Aug **4 missing**. Totals **36 rows
the CRM has that Phoenix lacks, 473 rows Phoenix has that the CRM deleted**; 353 of those 473 are
`visit_type = 0` real doctor calls, concentrated in just 3 reps (181 / 167 / 5).

**The sync algorithm is NOT at fault** — `syncIReports360Visits` is a true set-equality operation for
whatever window it is handed (upsert everything fetched, delete every mirror row the fetch did not
see, with a 50%-truncation guard). **The cause is COVERAGE:**

- live sync = today only, and only inside the 08:30–12:01 window; scheduled sync = 10-day lookback;
  wide reconcile = ONE 30-day slice per week rotating over 120 days (`WIDE_RECONCILIATION_TOTAL_DAYS`).
- So days 11–120 are re-checked **once per 4 weeks**, and **days older than 120 are NEVER re-checked
  again.** Measured: 53,068 rows (42%) sit past the window, and Jan/Feb/Mar were last compared to the
  CRM on **2026-07-24**.
- The trigger is **late saves**. Every missing row was saved long after its own visit date — the 4
  August ones 18–22 days later, the 32 May ones **91 days** later. `iReports360GetVisits` filters on
  `visitDate` only; **the vendor has no "saved since" filter**, so a late save is invisible to every
  window that has already moved past that date.

**The fix that guarantees it:** the whole history is only 8 API calls (~5–9s per month, ~60s total),
so run a parity sweep over EVERY month from `min(visit_date)` to today, compare id sets, and call
`syncIReports360Visits` on any window that differs. It is proof, not inference — equal id sets ARE
equality. Record per-window "last proven equal" and alarm on both inequality and staleness.

## Problem 2 — attribution (1,619 rows filed under the wrong person)

**Even with a perfect row set, the row can be filed under the wrong employee, and this is the BIGGER
number.** 1,619 mirror rows — **1,114 of them real doctor calls, across 34 employees** — carry an
`agent_hr_id` whose `hire_date` is AFTER the visit date. Worst: **Soad Atef (AI-0003), hired
2026-06-20, credited with 1,136 visits / 931 real calls going back to 2026-01-01 — 170 days before
she joined.** Also Mohamed Yasser 232, Mohamed Raffat 154.

**Cause — the owner's own explanation, and he had told me before:** when a rep resigns the CRM admin
hands the account to the replacement in the same area *by overwriting the account with the new
person's details*, so the newcomer inherits the contact list. The vendor then serves **the whole
history under the new label**, so the historic rows become the new person's.

**Why the existing guard misses it: `isAttributableOn` (`src/lib/crm/identity.ts`) tests
`last_working_date` ONLY — the post-exit side. There is no `hire_date` test at all.** And its label
comparison cannot save it either: measured `crm_labels_on_those_rows = 1` for Soad Atef, i.e. the
CRM had rewritten the label on every historic row, so the record's label matches her roster label
perfectly. **A pre-hire guard must be date-based; the label test that works post-exit is useless here.**

🔴 **NEVER name a rep from a CRM row without checking `hire_date` first.** On 2026-08-28 this session
reported "Ahmed Nabil made 32 real doctor calls on 7 May" — he was hired **2026-05-16**, nine days
later, and the rows had been saved 2026-08-06 and back-dated. The owner caught it, having warned
about this before. Account 1537 held no rows before 2026-05-15 in the mirror, so those 32 were
CREATED in August and back-dated, not history Phoenix lost. See
[[crm-resigned-slot-reused-for-new-hire]].

**Two non-defects proven along the way — do not re-raise either.** `double_crm_id` "differs" on ~88%
of rows only because the vendor sends `0` for "no double visit" and Phoenix correctly stores `null`;
real double ids match. And a `visit_type = -5` row is an admin broadcast to the whole roster, not
activity — see [[public-holiday-and-casual-leave-are-working-days]].
