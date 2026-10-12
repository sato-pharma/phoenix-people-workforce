# Half Day (CRM) — is the trace that clears a half independent of the rep?

🔴 **A REPORT, NEVER A CHANGE.** Nothing described here raises, clears, re-dates or retracts a
deduction, and nothing here is a verdict about a person. A half day is money, and money is decided on
the **deductions screen** — the owner's own ruling, restated when he commissioned this work on
12 October 2026: *"gap 17 touches money → report only, never change a deduction from here."*

Gap 17 of the second-pass CRM audit asked for a CRM visit to be checked against the attendance
punches. It cannot be, and the measurement below is why; what can be checked — and now is — is
whether the thing that CLEARS a half day came from outside the rep's own typing.

`scripts/check-half-day-trace-independence.ts` is the report. It reads, it writes nothing, it exits 0
whatever it finds, and it refuses to run from a tree behind `origin/main` (`scripts/lib/tree-is-current.ts`)
because it recomputes the rule from the code it runs in.

## Why "CRM visit versus the punches" would read green forever

The device punch feed is **alive and current** — and it is head office only. Read on production
(`ozucdzovmcqvepbozvqf`) on 12 October 2026:

| Month (Cairo) | Punches | People | Last punch (Cairo) |
| --- | --- | --- | --- |
| 2026-07 | 510 | 17 | 2026-07-30 18:21 |
| 2026-08 | 575 | 16 | 2026-08-31 18:18 |
| 2026-09 | 647 | 16 | 2026-09-30 17:53 |
| 2026-10 | 171 | 15 | 2026-10-12 11:44 |

Everyone on that feed is head office: admin, HR, product and national managers, the SFE Manager, and
B-10 himself. **No medical rep and no district manager punches a device at all** — the field force
was never on it. The script's own run for 2026-10 says the same from the other side: of **95
CRM-active people, 6 have at least one punch and 89 have none**, against **15 people** on the whole
feed.

So a check comparing a field visit with that day's punches would compare the whole field force
against an empty set and report green every time. That is worse than having no check, which is why
gap 17 was not implemented as the audit described it.

🔴 **A repo comment said the feed was DEAD, and it is not.** `src/lib/reconciliation/checks/deductions-attendance.ts`
carried a 2026-08-04 note — "the last punch … is 2026-07-30 … and none exist after it" — which was
true that day and has not been since; ingestion resumed in August. It is corrected there, dated, with
the counts above. A session reading the old line concludes the punches are gone and stops looking.

## What the report actually measures

`judgeHalfDay` charges a half day when exactly one half of a working day is covered, and clears it
when a trace shows the missing half was worked (`morningProof` / `eveningProof`,
`src/lib/deductions/half-day-rule.ts`). Two things can raise that proof:

1. an **iReports360 GPS check-in** — recorded by the old app at a customer, independent of whatever
   the rep later typed, and the only outside witness in the whole rule;
2. the visit's own **`crm_save_date`** — the hour he pressed Save. That is not an independent trace:
   it is the same action as the visit, timed by the tap that created it.

As Phoenix CRM replaces iReports360 team by team, (1) disappears for a started team and (2) is what
is left. The report names the person-days where the only thing standing between a half day and a
clearance is the rep's own save time.

**No rule is re-implemented** (`never-hand-roll-a-rule-the-repo-already-implements`):
`buildHalfDayEvidence` is called twice, unchanged — run A with the real check-ins as the connector
calls it, run B with `checkins: []`. Check-ins feed nothing but the proofs, and AM/PM placement reads
the visit row alone, so a proof that survives run B came from inside the CRM and a proof that exists
only in run A had an outside witness.

`queryCheckins` filters its own source — `.eq("source", IREPORTS360_VISIT_SOURCE)` on both branches
(`src/lib/crm/reads.ts`) — and the half-day connector does not pass `includePhoenixVisits`, so its
check-in set is iReports360-only and the comparison is **not** circular. (Two earlier readings of
this file claimed otherwise, including that `countGpsTracesByDate` double-counts a Phoenix visit.
Both were wrong; neither is a defect.)

## October 2026, measured

- Visits read **4,568**; iReports360 check-ins read **4,197**.
- Person-days with exactly one half covered: **86**.
  - cleared by an **independent** iReports360 check-in: **19**
  - cleared **only by the rep's own save time**: **18** (9 of them on Phoenix visits)
  - not cleared by any trace at all: **49**
- The 18 are printed by name, day and missing half. One recurs: **Ahmed Farag Soliman Elakraa**, a
  missing AM on 4, 5, 6, 7 and 10 October, each cleared only by his own save time.

**What this is not.** The report applies no vacation cover, no national holiday, no ledger conflict
and no employment window — only the Friday and Thursday drops the rule itself applies
(`isFieldForceWorkingDay`, `isFieldWorkforceThursday`). A day it prints is a day whose clearing trace
is not independent. It is not a half day, not a candidate, and not a charge.

## Running it

From the repo root, with a populated `.env.local` (this reads production):

```bash
node --env-file=.env.local --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs scripts/check-half-day-trace-independence.ts 2026-10
```

`[YYYY-MM]` defaults to the current Cairo month; `--all-days` keeps days the rule drops, `--limit N`
caps the printed list. A Supabase read can time out on a slow line — it is a read, so re-run it.
