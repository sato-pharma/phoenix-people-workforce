# A half the contract does not cover was never owed

**Owner, 2026-10-12, 21:3x Cairo:** *"ahmed farag is part time he works pm only"*.

He said it while reading the first run of the October half-day trace report, which had just listed
five of Ahmed Farag's afternoons among its findings — each one as a morning he had failed to record.

## What the platform could not know

`employees.contract_type` already existed, and the employee import already accepted
**Full time · Semi-full time · Part time**. But across all 214 employee rows it held only
`full time` (178) or null (36): **not one person in the company was recorded as part time**, Ahmed
Farag included. His row said `full time`.

So neither the deductions engine nor the report had any way to tell a contract from an absence, and
`judgeHalfDay` read his missing morning as an unrecorded half on every working day he had. Its own
reason line, rendered to a reviewer, said:

> Worked the afternoon only — nothing recorded for the morning: no visit, check-in, approved
> vacation or request

For him that sentence is a description of his contract, printed as an accusation.

🔴 **The `am_only` / `pm_only` already in the half-day code is NOT this.** That is `LeavePart` — the
part of ONE day an approved **half-day vacation** covers. A contracted working pattern and a single
day's leave look identical as strings and mean opposite things; the column and the type are kept
apart deliberately.

## The column

`employees.work_half` — `full_day` (default) · `am_only` · `pm_only`, with a CHECK constraint.
Applied to production and staging on 2026-10-12; all 214 existing rows took the default, so nothing
changed behaviour on arrival. Ahmed Farag's row was then set to `contract_type = 'part time'` and
`work_half = 'pm_only'` on the owner's word above.

`halfDayContractOf` normalizes what it reads (`"PM only"`, `"pm-ONLY"` → `pm_only`), and **anything
that does not NAME a half is a whole day** — `part time` on its own included. A mis-typed contract
can therefore never become a free pass.

## The order is the rule

`judgeHalfDay` reads the contract **before** it asks for any trace:

```
missing half computed
  → is this half outside the contract?   → left_alone / outside_contract_half
  → morning / evening proof?             → cleared / *_trace
  → otherwise                            → half_day
```

🔴 **Reading it after the proof checks is a silent defect, not a stylistic choice.** A part-timer
whose own save time happens to fall in the missing half then comes back `cleared / morning_trace`:
the day is not charged, so nothing looks wrong, but his afternoon has been credited with morning
evidence that does not exist and he stays inside the witnessed group where nobody looks again.
**Those were exactly five of Ahmed Farag's October afternoons.** Both halves of the gate are broken
on purpose in `tests/deductions-half-day.test.ts` and watched to fire — removing it raises
*"a PM-only contract never owed the morning"*, moving it below the proofs raises *"a PM-only contract
is read BEFORE any morning trace"*.

It is `left_alone`, never `cleared`: a cleared day found a witness, and here there is no witness and
none is owed. Collapsing the two would lose the distinction the report depends on.

The half he **is** contracted to work still charges when nothing records it — a PM-only rep who
logged only a morning is still missing his contracted afternoon.

## What it changed in the October report

Re-run on production the same evening, with his contract on file:

| October 2026 (to the 12th) | Before | After |
| --- | --- | --- |
| Person-days with exactly one half covered | 84 | 75 |
| …cleared by an independent iReports360 check-in | 19 | 18 |
| …cleared ONLY by the rep's own save time | 16 | **11** |
| …cleared by no trace at all | 49 | 46 |
| …left alone, half outside the contract | — | **7** |

His seven days — five that his own save time had "cleared", two that nothing cleared — left the
findings entirely. The small movement in the other rows is visits saved between the two runs.

## The report also stopped under-reporting

The same run exposed a second fault of the report's own. It **named** the weakly-cleared days and
only **counted** the ones no trace clears — so it read as though the weakly-cleared group were its
finding, when that group is the safer half. The no-trace group is what the live rule actually
raises, and it is now named too.

🔴 **Neither list is a half day or a charge.** The report applies no vacation cover, no national
holiday, no ledger conflict and no employment window, so the no-trace count is an upper bound on
what the engine would raise — not a bill. The deductions screen is where a half day is decided.

## Still open

The owner said there are **other** part-time people and that he will name them. Until he does,
`work_half` reads `full_day` for everyone except Ahmed Farag, which is exactly today's behaviour for
all of them. There is no edit screen for `work_half`: `contract_type` arrives through the employee
import and this column is set from his word.
