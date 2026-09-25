---
name: public-holiday-and-casual-leave-are-working-days
description: "OWNER RULE 2026-08-21 — CRM visit types -5 (Public Holiday) and -6 (Casual Leave) count as WORKING days, never AV; independently re-verified 2026-08-21, incl. which map is actually load-bearing"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-08-21T05:52:51.770Z
---

**Owner ruling, 2026-08-21:** iReports360 visit types **`-5` (Public Holiday)** and **`-6` (Casual
Leave)** count as **WORKING days** — status `CP`, never `AV`. Asked and answered; do not re-open it.

Both already behaved this way, but only because they were **absent** from the two AV/CP maps and fell
through the `?? "CP"` default — an accident, not a decision. #2253 lists them explicitly in both maps:

- `src/lib/field-workforce-compliance/ireports360-source.ts` → `VISIT_TYPE_TO_STATUS`
- `src/lib/automated-payroll/recommend.ts` → `LEAVER_VISIT_TYPE_TO_STATUS`

**Why:** `AV` is not cosmetic. It consumes the employee's annual leave balance and, once that runs
out, is **deducted from salary** on the payroll Vacation step. `-15` (Health Day) was mapped to `AV`
once and cost **22 days across 11 employees in July 2026** (33 in June, 22 in May).

🔴 **INDEPENDENTLY RE-VERIFIED 2026-08-21 (not by the session that shipped it). Four things the
original note got imprecise — keep these, they change where you look next time.**

1. **Only ONE of the two maps is load-bearing on money. `LEAVER_VISIT_TYPE_TO_STATUS` in
   `recommend.ts` is effectively DEAD** — its sole reader is the exported `leaverVisitTypeStatus`
   accessor, whose sole callers are the test. The real chain is
   `VISIT_TYPE_TO_STATUS` → `dayCellValue` → FWC cell `"AV"` → `classifier.ts` `"vacation_signal"` →
   `loadCrmLeaveDatesByCompact` (`recommend.ts:533`, which calls the **FWC engine**, not its own map)
   → balance, then salary. So a wrong `-5` in **ireports360-source.ts** costs money; the same wrong
   value in `recommend.ts` costs nothing. Fix the FWC one first, always.
2. **The two salary paths that charge leave filter `visit_type = -4` DIRECTLY at the query level** —
   `deductions/connectors/vacation.ts:560` and `vacation/company-vacation-report.ts:280` — so they
   are structurally immune to any map edit. That is a real safety margin; do not remove it.
3. **`-5` and `-6` are DORMANT — zero production rows since 2026-04-25 and 2026-02-08.** Monthly
   counts: `-5` 199/149/800/485 for Jan–Apr then **0 in May, Jun, Jul, Aug**; `-6` 20/6/0/0 then 0.
   Meanwhile `-4` and `-15` flow every month. And `deductions_candidates` only holds **2026-07 and
   2026-08** — so no `-5`/`-6` day has ever been in a period the deductions engine processed. The
   "1,659 days at risk" figure is real but **historical**: it only bites if an old month is
   reprocessed. This is defensive documentation, not a live-bug fix, exactly as the commit says.
4. **The shipped comment is wrong on one fact.** It says *"iReports360 sends no description for
   either"*. It sends the literal string **`"Unknown"`** — confirmed on prod for all 1,633 `-5` and
   26 `-6` rows, and `src/lib/crm/visit-types.ts:5` (the file the comment points to) says so itself.
   Harmless today: `"Unknown"` does not match the `%vacation%` ilike (measured: 0 of 1,659 match,
   vs 607 of 607 for `-4`, whose description IS "Annual Vacation"). But the ilike **would** eat them
   if the display label `"Vacations & Leaves"` were ever stored — see
   [[ireports360-undocumented-visit-type-codes]].

**Break-verification re-done from scratch 2026-08-21** in a detached worktree (never in the main
checkout — other sessions are live there). All four flips fire the test's OWN headline assertion:

| Flip | Test that goes red | Assertion text that fires |
| --- | --- | --- |
| `-5`→AV in FWC map | field-workforce-compliance-eligibility | "Public Holiday (-5) is a worked day, never AV…" |
| `-6`→AV in FWC map | field-workforce-compliance-eligibility | "Casual Leave (-6) is a worked day, never AV…" |
| `-5`→AV in payroll map | automated-payroll-step-detail | "visit type -5 is a worked day" |
| baseline | both | green, and **neither test needs credentials** |

The two tests are **independent** — breaking one map leaves the other test green. Both are registered
in `run-tests.ts` (lines 1074, 1609). Runner: `node --experimental-strip-types
--experimental-loader ./tests/alias-loader.mjs`, **without** `--env-file-if-exists=.env.local`
(that file points at production).

**How to apply:** `-4` (Annual Vacation) is the ONLY genuine leave type in these maps. Everything
else is `CP`. If either test goes red, do NOT re-pin it — something started charging leave for
worked days.

⚠️ **There is a THIRD mirror and #2253 did not touch it** — see
[[crm-visit-type-maps-there-are-three-not-two]]. It is missing `-5`/`-6` entirely and still calls
Health Day leave.

Related: [[ireports360-undocumented-visit-type-codes]] (what each code means, and the display labels
that must never be stored in the DB).

🔴 **OWNER RULE 2026-08-28 — a `-5` row is an ADMIN BROADCAST, never a signal that anyone worked or
is still employed.** Owner's words: *"the public and national vacations, it is published by the CRM
admin. It reaches every single one in the CRM. It's not a measurement that this employee is still
working or not."* Measured the same day and it is exactly that: on **2026-08-27** (المولد النبوي
الشريف) a single `-5` row went to **168 of the 171 agents** on the CRM roster — 98.2% — every one
carrying the identical comment `اجازة بمناسبة المولد النبوي الشريف`.

**The trap this closes.** Because the broadcast reaches the whole CRM roster, it lands on **people
who have already left**, whose logins are still on that roster. Joining `ireports360_visits` to
`employees` without filtering visit type therefore makes departed staff look active: it showed **27
non-active reps "logging visits in the last 7 days"** and **23 with "visits dated after their last
working day"**. Filtering to real calls (`visit_type = 0`) collapses that to **2 people, 15 calls,
both within a day of their last working date** — ordinary end-of-employment overlap, no incident.
**Never read presence in `ireports360_visits` as activity or employment. Count `visit_type = 0`.**
See [[campaign-visits-make-a-working-rep-look-like-a-zero]] for the mirror-image error.

🔴 **CORRECTION to the "DORMANT" claim above — `-5` came BACK on 2026-08-27, and that sentence is now
wrong for August.** Re-measured 2026-08-28. Rows per month: Jan 199, Feb 149, Mar 800, Apr 485, May
**0**, Jun **0**, Jul **0**, **Aug 168** (168 distinct agents, all on 2026-08-27). So the four-month
gap was real but it has ENDED — do not plan around `-5` being dormant, and re-count before asserting
it either way.

**Payroll consequence, verified in the same pass: none, and the guard held.** `VISIT_TYPE_TO_STATUS`
(`src/lib/field-workforce-compliance/ireports360-source.ts:81`) still carries `[-5, "CP"]`
explicitly, so all 168 days classify as WORKING and no leave balance or salary is touched. Worth
noting how close this ran: the owner's ruling was made **2026-08-21** and the first `-5` in four
months arrived **2026-08-27**, six days later. Had it stayed an implicit fall-through to the `?? "CP"`
default rather than being listed explicitly by #2253, those 168 company-wide days would have been one
edit of that default away from becoming charged annual leave.
