# Features that shipped and were never reached

Four things in Phoenix were built, merged, deployed, and then did nothing. Not broken loudly —
each one is green in CI, healthy at deploy, and silent in production. This document records what
they are, how each was proved, and what it would take to finish or retire them.

**These are reported here and fixed separately, by the owner's decision on 2026-08-29.** Nothing in
this document is a change request; three of the four need a product decision before any code moves.

**Everything below was measured against the live production database
(`ozucdzovmcqvepbozvqf`) on 2026-08-29**, not read from a memory file or a plan. Where a figure is a
counter that keeps moving, that is said in the line itself.

## Why these are hard to see, and why that is the real lesson

Zero usage and zero reachability look identical from outside.

A feature nobody has adopted yet shows no rows. A feature that physically cannot be reached also
shows no rows. There is no error in either case, no alert, no red check — the dashboard just says
zero, and zero is a perfectly ordinary number for something new. Phoenix has been caught by this
before: the Capture Evidence module rejected **59 of the 65 customers it existed for** for months,
and the only symptom was that no evidence files were captured, which read exactly like slow uptake.

So the rule these four findings all point at:

> When a shipped feature shows zero usage, exercise the path end to end **once** before concluding
> it is adoption.

---

## 1 · The employee history log has never received a single row

`employee_history` is meant to be the permanent record of what happened to each employee — hired,
promoted, resigned. It holds **0 rows**, and its ID counter has **never advanced once** in the life
of the database.

That second fact is the one that settles it. Row counts can be emptied; a sequence that reads `null`
proves nothing was *ever* written, regardless of what has been deleted since. Meanwhile the
resignation flow it exists to record has run for real: there are **54 resignations** in the system.

The cause is a fork in the road that nobody noticed was a fork. There are four database functions
here, and the one the application actually calls is the only one that does not write the log:

| Function | Writes `employee_history` | Called by the app |
| --- | --- | --- |
| `resign_employee_and_open_vacancy` | **yes** | **no — 0 call sites** |
| `accept_offer_and_create_employee` | **yes** | **no — 0 call sites** |
| `finalize_manual_employee_lifecycle` | **yes** | **no — 0 call sites** |
| `phx_resign_employee_and_open_vacancy` | **no** | **yes** — `src/lib/resignations/service.ts:1489` |

At some point the resignation path was rewritten under a `phx_` name. The new function does the job
correctly in every other respect; it simply never carried the history write across. The old function
still exists, still writes the log, and is called by nothing.

`employee_contracts` is in exactly the same state — 0 rows, counter never advanced — while being
scanned **169,404 times**, so live code reads it constantly and finds nothing there.

**Cost:** there is no audit trail of employee lifecycle events. Nothing was lost that was ever
written; the writing never started.

**What it needs:** a decision on whether the history log is still wanted. If it is, the write belongs
inside `phx_resign_employee_and_open_vacancy`'s transaction and the three orphaned functions should
go. If it is not, all four should go, and `employee_history` should be retired with the rest.

---

## 2 · The employee deductions portal has nothing to show, by construction

`src/lib/deductions/portal.ts` builds an employee's deductions view by merging two sources: the
current module's published lines, and the older module's summary lines. Both are empty in production:

| Table | Rows | Ever inserted |
| --- | --- | --- |
| `deductions_publications` | 0 | 0 |
| `deductions_publication_lines` | 0 | 0 |
| `deduction_monthly_summary_lines` (legacy) | 0 | 0 |

`phx_publish_deductions` — the function that would fill the first two — has never produced a row.

This is *not* the same as saying deductions do not work. The surrounding module is busy and real:
`deductions_candidates` holds **1,771** rows, `deductions_decisions` **1,770**, `deductions_audit`
**1,534**. Deductions are being detected and decided every month. What has never happened is the
final **publish** step that makes them visible to the employee.

⚠ A caution about the table names, because this bit already tripped up the plan that led here.
There are two families, differing by a single letter: singular `deduction_*` (the legacy module) and
plural `deductions_*` (the current one). They are not the same tables and several exist in both
spellings. Read the prefix carefully before quoting any number from this module.

**Cost:** employees cannot see their own deductions in the portal. Nothing is mis-paid — this is a
visibility path, not a money path.

**What it needs:** confirmation of whether publishing to employees was ever intended to be switched
on. The owner's standing rule is that a deductions month is never auto-published, so a never-used
publish path may be entirely deliberate.

---

## 3 · An audit table nothing writes, and a grant that is wider than it looks

`sensitive_data_access_audit` is designed to record who looked at sensitive employee data. It holds
**0 rows** and has never been inserted into, while being scanned 154 times.

Its grants are also wider than an audit log should carry: the `authenticated` role holds **every**
privilege on it, including `TRUNCATE`. That matters more than it first appears, because **row-level
security does not apply to `TRUNCATE` at all** — the table's three policies gate reading and
inserting, and none of them gate emptying it. There is no `BEFORE TRUNCATE` trigger either, and a
row-level trigger would not fire on a truncate even if one existed.

**This is a hygiene finding, not an incident, and the difference matters.** Having checked the whole
schema rather than this one table:

- **68** public tables grant `authenticated` all privileges; **25** of those also grant `anon` all
  privileges.
- **Row-level security is enabled on every single one of them.** There is no open-door table.
- The one table in that set with **zero policies** — `source_of_sales_customer_map`, 66,109 rows —
  is therefore **deny-all**, which is the safest state rather than the worst. It is worth saying
  plainly, because "RLS on, no policies" reads alarming and means the opposite.
- The public API layer exposes no `TRUNCATE` verb, so the surplus privilege is not reachable with
  the keys the browser holds. It would matter only to something connecting to Postgres directly as
  those roles.

**Cost:** today, none. The exposure is latent and the audit table is empty.

**What it needs:** revoke `update, delete, truncate` from the named roles on the audit tables, and
add a statement-level `BEFORE TRUNCATE` guard to anything described as append-only. Then decide
whether the audit table is wanted at all — nothing writes it, so it currently protects nothing.

---

## 4 · Adverse-drug-reaction reporting has received zero reports

`report_it_reports` holds **0 rows** and has never been inserted into. It is scanned constantly —
**1,282 sequential scans**, up from 1,277 when this was first measured a few hours earlier, so the
screen is genuinely being opened and read right now.

The code behind it is fully live: `src/lib/report-it/service.ts`, and API routes for `submit`,
`list` and `[id]`.

**This one deserves more care than the other three.** Despite the name, "Report It" is not an HR
suggestion box — it is **pharmacovigilance**: adverse drug reactions to the company's products. Two
readings fit the evidence equally well, and they have opposite consequences:

- Nobody has had anything to report. Entirely plausible.
- The submit path is broken, and every attempt to report a reaction has silently failed.

Zero rows cannot distinguish them, and this is precisely the category where being wrong is
expensive — a missed adverse-event report is a regulatory matter, not a UX one.

**What it needs:** exercise the submit path end to end, once, in production, and then delete the test
row. That single action resolves it either way. Until that is done, **no conclusion about adoption
should be drawn**, and this module must not be included in any retirement sweep.

---

## What none of this is

- **No money moved wrongly.** None of the four sits on a payroll calculation. The Payroll Copilot,
  which is often assumed to be involved, has produced **0 salary batches ever** — 7 batches exist in
  total, the newest created 2026-08-10, none of them from the Copilot.
- **Nothing was deleted.** Every one of these is a write that never started, not data that was lost.
- **No CI check could have caught any of them.** All four compile, pass every required check, and
  deploy cleanly. They are only visible by asking the database whether the feature ever ran.

## How each was proved

| Claim | Evidence |
| --- | --- |
| A table was **never** written | `pg_sequences.last_value IS NULL` — survives deletions, unlike a row count |
| A table's real size | `query_to_xml(format('select count(*) …'))` — `n_live_tup` is stale in this project and reports live tables as empty |
| A table is still **read** | `pg_stat_user_tables.seq_scan`, treated as a ~32-day window, not all-time |
| A function is orphaned | `pg_proc.prosrc` for the write, plus a repo-wide search for the call |
| A grant is real | `pg_class.relacl` and `pg_policy`, never a code review |

---

*Recorded 2026-08-29 as part of the repair program that followed the commit-history audit. Verified
against production, not against a plan.*
