# Automated Payroll — Audit Cycle 3 (in progress)

**Opened:** 2026-09-12 · **Findings covered:** 14–18, 20, 22, 23, 26, 27, 29–55 (37 of them)
**Status:** TIER 1 VERIFIED (12 of 37) · TIERS 2-4 NOT STARTED
**Cycle 1:** [audit-ledger.md](audit-ledger.md) · **Cycle 2:** [audit-cycle-2.md](audit-cycle-2.md)

> This document exists **before** the first fix PR of the cycle, not after the last one. That
> ordering is the process fix cycle 2 established, and it is the reason cycle 1 lost fourteen
> findings. Tier 1 carries results as of 2026-09-12; Tiers 2-4 are still unticked.

## Why this cycle exists

The owner supplied a list of 37 findings on 2026-09-12, headed "still open", carrying plain-English
descriptions for each. Two things followed immediately.

**First: the repository disagrees with the list.** All 37 are recorded as fixed, and **34 of them
name a merged pull request** — #3696, #3699, #3701, #3703, #3706, #3707, #3708, #3709, #3711, #3712,
#3717, #3731, #3741, #3746, #3752. The list is a snapshot taken before those landed. It is not a
backlog.

**Second, and far more important: the original audit document exists.** The owner confirmed it. That
contradicts a sentence this repository currently publishes — cycle 2 and the ledger both state that
the wording of the missing findings "cannot be recovered from anything the company holds."

### What that does to the ruling of 2026-09-12

On 2026-09-12 the owner ruled that findings **1, 6–13, 21, 24, 25, 28 and 19** are closed as
permanently unrecoverable. That ruling was made on the stated basis that no source survived.

**The basis was wrong, so the ruling is suspended pending the document** — not reversed, and not
quietly dropped. None of the fourteen appear in the 37-finding list, so nothing has been recovered
yet. What has changed is that recovery is now possible, and a decision taken because something was
impossible cannot stand unexamined once it turns out to be possible.

The correction to the ledger, the cycle-2 document and the registry ships in the **same** pull
request as this cycle's results. One production deployment per task.

## Why "already fixed" is not the same as "verified"

Every one of the 37 is closed on the strength of **a merged pull request description**. Cycle 2
demonstrated what that is worth: `phx_delete_salary_batch` was covered by a migration that read
correctly, was described accurately in its PR, and still disarmed all three of its guards on every
call. The defect was in the interaction, not in any one file.

So this cycle re-verifies each finding **empirically** — against production data, the emitted
artifact, or a forced failure — never against the source that claims to fix it.

## A known gap in the cycle-1 record, found while writing this

**Finding 14 is counted in the ledger's "fixed with evidence" total of 39, but it has no detail row
and names no pull request.** The ledger already flags 30 and 36 as claimed-closed-without-a-marker;
it does not flag 14. That is an error in the record, not in the code, and it means the real
"fixed with evidence" count is 38, not 39. It is corrected in the same PR as the rest.

## The 37, by what a defect there would cost

### Tier 1 — pays the wrong amount, or pays twice

A defect here moves money into or out of a real person's account. Verified against production data and the emitted artifact, never the source.

| # | In one line | Claimed fixed by | Re-verified |
| ---: | --- | --- | :---: |
| **16** | The same non-employee can be seeded automatically and typed in by hand on one run, and be paid twice. | #3696 | ☑ |
| **17** | Syncing the standing list during Part 2 can add money to a Part 1 that is already paid, and that row can then never be removed. | #3696 | ☑ |
| **22** | Changing someone's payment mode between the two confirms charges their loan twice, or drops it entirely. | #3703 | ☑ ⚠ |
| **23** | The Additions step writes unlimited money with no source, no reason, and no audit record of two of its three fields. | #3707 | **partly** |
| **39** | An employee can be excluded from a run after their first instalment was paid, erasing them from every record. | #3712 | ☑ |
| **41** | The insurance-wage spreadsheet import accepts any positive number, with no legal floor or ceiling. | #3712 | ☑ |
| **42** | A negative bonus is accepted end to end and becomes a deduction nothing checks. | #3717 | ☑ |
| **37** | A CRM or vacation deduction changes amount the moment anyone touches its day box, in any month that is not 30 days long. | #3752 | ☑ |
| **29** | Someone hired and leaving in the same month is paid from the 1st, not from their hire date. | #3711 | ☑ |
| **32** | Correcting a leaver's days worked by spreadsheet changes the day count but not the money. | #3717 | ☑ |
| **36** | The Ready payroll sheet pays a full unprorated month to a leaver whose resignation is still in the workflow. | **no PR named** | **no marker** |
| **20** | Reopening Part 1 to correct a salary does not actually re-derive it for joiners or leavers. | #3706 | ☑ |

### Tier 1 — results, 2026-09-12

**Ten of the twelve verified. One is partly fixed by deliberate decision. One names no code at all.**

Every ☑ above was established the same way: the fix was broken on purpose, the check that should
catch it was watched firing, and the file was restored from a byte copy. A green check on unmodified
code proves only that the code runs.

| Finding | What was broken to prove it | What fired |
| ---: | --- | --- |
| **16** | `identityOf` → null, the old recurring-id-only guard | a hand-typed person seeded on top of themselves: `inserted=1` |
| **17** | `partStillOpen` → always true, the old "not gated on the run phase" | a first-instalment row written onto a paid Part 1 |
| **20** | `unconfirmPart1` stops clearing `baseForMonth` | **the repo's own required-CI guard**, `automated-payroll-run-integrity` |
| **22** | the stamp ignored, and the Part 2 backstop disabled | all three routing checks plus both backstop checks |
| **23** | the reason requirement removed; `MONEY_FIELDS` cut to incentive; `fieldTotals` emptied | refusal, three-field total, audit record |
| **29** | the hire date discarded by the leaver settlement | an 11-day settlement became 20 days |
| **32** | the sheet parser stops re-pricing a corrected day count | 4.5 days still priced at the 12-day figure |
| **37** | the divisor hard-coded back to 30 | the 31-day, the February and the fail-closed checks |
| **39** | (guard already proven pure; verified against production instead) | — |

**What production says.** Both runs — July and August 2026 — are published, 244 draft rows, 241 not
excluded.

| Question | Answer |
| --- | --- |
| Anyone excluded after their first instalment was paid (39)? | **0.** Three exclusions, all with no frozen first part |
| Anyone charged the same deduction in both instalments (22)? | **0** — CRM 0, unpaid vacation 0, loan/other 0 |
| Any negative value in any money column (42)? | **0**, across every addition, deduction and total |
| Any insurance wage outside the legal band (41)? | **0** of 167; band 2,700–16,700, stored range 5,600–16,700 |
| The same non-employee paid twice on one run (16)? | **0.** 14 rows — 7 seeded, 7 typed by hand — no duplicate identity |

#### The three answers that are not a clean tick

**23 is two thirds fixed, and the missing third is a question for the owner.** An addition with no
reason is now refused at confirm, and the audit record carries bonus and overtime instead of only
incentive. But the finding also asked for an **upper limit, and there is none** — verified: a
5,000,000 EGP bonus with the one-word reason "because" is accepted. That is a deliberate choice
recorded in the code: *"a limit is a number only the owner can give."* It is correct not to invent
one. It is not correct to carry the finding as closed while the cap is open, so **it is listed here
as partly fixed until the owner names a figure — or rules that no cap is wanted.**

**22 and 23 are fixed for the next month, not proven on a month that has run.** All 244 production
draft rows carry `settled_in_part1 = null`, and all 5 rows with an addition carry no reason —
because July's Part 1 was confirmed on 26 July and August's on 30 August, both **before** #3703 and
#3707 merged on 11 September. A null stamp falls through to the live rule, which is exactly the
pre-fix behaviour. Neither guard has ever run in production. **September's run is the first real
test of both.** Neither published month can be corrected, and neither shows a defect.

**36 names no file anywhere in the repository** — no PR, no code marker, no test. That confirms the
ledger's own "claimed closed, no code marker" note empirically rather than resolving it. It stays
outside the ruling of 2026-09-12, as the ledger already says, and it cannot be verified until the
original audit document says what it was.

#### Noted on the way, not yet a finding

`writeAutomatedPayrollAudit` **swallows its own failure**: when the audit insert threw during this
verification, the seed still reported success and the money rows still went in. That is deliberate —
payroll must not fail on a logging error — but it means the audit trail can be silently incomplete,
which is the same class of problem as finding 26. It is carried into the Tier 3 check of 26 rather
than opened as a new finding.

### Tier 2 — silently drops money, people or reasons

These fail quietly. A green screen showing zero is the failure mode, so each is verified by forcing the failure and reading what the user is actually told.

| # | In one line | Claimed fixed by | Re-verified |
| ---: | --- | --- | :---: |
| **14** | One failed database read in the CRM collector silently retracts every live CRM deduction for the month. | **no PR named** | ☐ |
| **34** | A failed leavers query silently removes every already-resigned employee from the whole run. | #3699 | ☐ |
| **35** | If the expense query fails, the Expenses step shows nobody and every reimbursement freezes at zero. | #3717 | ☐ |
| **49** | The mutual-exclusion check between the two payroll engines fails open when its own query errors. | #3717 | ☐ |
| **44** | One expense-approval save can wipe frozen expense figures in a month that did not change. | #3717 | ☐ |
| **45** | Approved expenses belonging to someone outside the run are dropped with no row and no warning. | #3717 | ☐ |
| **43** | Every held employee is missing from the month's statutory filing. | #3717 | ☐ |
| **30** | An employee with no social-insurance figure is published at zero rather than flagged. | **no PR named** | ☐ |
| **48** | The Manual Deductions reason can be silently erased by a spreadsheet upload reporting no change. | #3717 | ☐ |
| **33** | The Unpaid Vacation template has two columns with the identical heading, and the importer reads the wrong one. | #3709 | ☐ |
| **31** | Three spreadsheet day columns can never be saved, but the upload preview reports them as changed. | #3717 | ☐ |
| **27** | Apply changes after a spreadsheet upload does nothing at all. | #3712, #3741 | ☐ |

### Tier 3 — control, concurrency and access

These do not move money by themselves; they remove the interlock that stops something else from doing it. Finding 56 was exactly this shape.

| # | In one line | Claimed fixed by | Re-verified |
| ---: | --- | --- | :---: |
| **18** | Nothing is re-checked at publish, and the run stays changeable after Part 2 is confirmed. | #3706 | ☐ |
| **26** | The payroll decision trail can be deleted, and nothing in the database stops it. | #3701 | ☐ |
| **50** | A concurrent cancel and Part 2 confirm can silently undo each other. | #3731 | ☐ |
| **51** | The CEO Payroll Console omits the company-scope check its sibling page has. | #3717 | ☐ |
| **40** | The locked finance workbook leaves the bank name and account number editable, contradicting its own cover. | #3712 | ☐ |
| **46** | The population comparison never blocks anything, and its baseline makes a held person look like a new hire. | #3717, #3731, #3746 | ☐ |
| **47** | An expense resync skipped because Part 2 is already confirmed is reported to nobody. | #3717, #3741 | ☐ |
| **52** | The Executive Summary compares this month including held people against last month excluding them. | #3717 | ☐ |
| **53** | Both acknowledgement gates accept a plain yes-flag sent on the first request, so the warning need never be shown. | #3746 | ☐ |

### Tier 4 — what people are told

No money moves, but someone is not told something true. Verified on the emitted artifact or the rendered screen.

| # | In one line | Claimed fixed by | Re-verified |
| ---: | --- | --- | :---: |
| **15** | 205 employees across two published months were never told their payslip was ready. | #3708 | ☐ |
| **38** | The workbook finance executes the month from never mentions holds on its cover. | #3741 | ☐ |
| **54** | The excluded-employees panel prints the raw HR code instead of the person's name. | #3741 | ☐ |
| **55** | The Payslips Center search for an HR code is case-sensitive, so a lower-case search reports no payslips. | #3741 | ☐ |
## Method

For each finding, in tier order:

1. **Read the live artifact, not the source.** For a database rule, `pg_get_functiondef` on
   production ref `ozucdzovmcqvepbozvqf` — `list_migrations` reports the ledger, not reality. For a
   workbook, the emitted file. For a screen, the rendered page.
2. **Force the failure the finding describes.** A read that "fails open" is only proven closed by
   making the read fail. Production tests run inside a transaction terminated by `raise exception`,
   against rows created for the test, so the transaction rolls itself back and no real batch is ever
   the target.
3. **Record the outcome either way.** A finding that comes back genuinely fixed is written down as
   verified, with what was run. A clean result is a real result and it is the majority outcome here.
4. **A finding that is NOT fixed becomes a new number**, from 57 onward — never a reopened old one.

## What this cycle must not do

- **Never re-attribute a new defect to a closed number.** The fourteen keep their numbers whatever
  the document turns out to say.
- **Never "fix" a published and announced month.** A late ruling is a rule for upcoming months.
- **Never trust a scan that reports a catastrophe.** Cycle 2 produced three false headlines — 99
  unchecked errors, 27 ungated routes, 6 ungated handlers — every one a tooling artifact. Check the
  actual file before believing any of them.
- **Never declare a regression test green without breaking the fix** and watching that test's own
  headline assertion fire, restoring from a byte copy.

## What is needed before verification starts

**The original audit document.** It supplies the exact wording of all 55 findings, which decides two
things this plan cannot: whether the fourteen are recoverable, and whether each of the 37 was
actually about what the ledger's paraphrase says it was about. Verifying a paraphrase proves nothing
about the finding.
