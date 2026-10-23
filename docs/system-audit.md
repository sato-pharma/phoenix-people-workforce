# System Error & Data Integrity Audit

The Super Admin page **SYSTEM ERROR & DATA INTEGRITY AUDIT** (`/admin/system-audit`) answers, for every
failure a person hit and every place the data went quietly wrong: who, in which sidebar module, when
(Cairo), what they saw, the reference, why, whether it is fixed and verified, how often it hit that
person, and whether it hit anyone else. It replaced four screens that gave misleading answers (see
"What it replaced, and why").

This file is the in-repo account. It holds no names and no HR IDs: the historical findings, with
names, live outside git in the owner's audit folder.

## The eleven columns

| # | Column | Where it comes from |
|---|---|---|
| 1 | HR ID | `canonicalHrIdForDisplay` of the person, as recorded when the finding was made |
| 2 | Employee Name | The name when the finding was made |
| 3 | Module Name | The **exact sidebar row label** the person's role sees, resolved by `src/lib/system-audit/sidebar-label.ts`. Never the stored `module_label` of `app_error_events` ("Other", "Api", "AI") |
| 4 | Error Date | Cairo calendar date of the failure; data findings use the time detected, and say so |
| 5 | Error Time | Cairo time of the same instant |
| 6 | Error Encountered | The message the person saw, when it was recorded. Otherwise "Error screen shown — exact wording not captured", or for a data finding "Silent data inconsistency — no error was shown". Never invented |
| 7 | Error Code / Incident Ref | The error code, plus the occurrence reference |
| 8 | Why | CONFIRMED / PROBABLE / UNKNOWN, with the cause and its evidence |
| 9 | Fixed? | FIXED — VERIFIED / NOT FIXED / INVESTIGATING / FIX IMPLEMENTED — NOT VERIFIED / NO DEFECT — EXPECTED BUSINESS BEHAVIOR / UNKNOWN — INSUFFICIENT EVIDENCE |
| 10 | Occurrences for this employee | Distinct operations by this person for this error over the selected period. Retries in one page load, or within 10 minutes, are one operation; one lost visit seen in several modules (one correlation id) is one operation |
| 11 | Unique vs Shared | "UNIQUE — ONLY THIS EMPLOYEE", "SHARED — N EMPLOYEES AFFECTED", or "SYSTEM — NO EMPLOYEE ATTRIBUTION" for a row with no person |

🔴 **Columns 10 and 11 are counted over the selected PERIOD, never over the filtered rows.** Filtering the
page to one person must not turn "SHARED — 4 EMPLOYEES AFFECTED" into "UNIQUE". Rows with no person are
never counted as an employee.

## The ledger

Two migrations: `supabase/migrations/20261023051847_system_audit_ledger.sql` (tables) and
`20261023051848_system_audit_functions.sql` (functions).

| Table | Holds |
|---|---|
| `system_audit_issues` | One row per error signature: family, code, title, status, root-cause level, cause and evidence (≤ 8 KB), first and last seen, and what the daily message last said about it |
| `system_audit_issue_fixes` | Each fix attempt: the 40-character commit, when it went live, verified or invalidated, and by which occurrence |
| `system_audit_occurrences` | One row per user-level operation: person, sidebar module and how it was resolved, Cairo date (generated column), message or silent flag, technical message (≤ 1,000 chars), attempts, page loads, up to 50 source ids, release, `pre_fix_build`, correlation id, `is_test`, a unique `dedupe_key` |
| `system_audit_status_history` | Append-only trail of every status change. UPDATE, DELETE and TRUNCATE are refused by trigger and by grant |
| `system_audit_detector_runs` | One row per detector run: what it scanned, what it excluded as noise per class, and for the nightly reconciliation the whole report |
| `system_audit_watermarks` | Each detector's cursor, and a lease so two runs never overlap |

RLS is on, with one service-role policy per table; nothing is granted to `anon` or `authenticated`.
The app reads the ledger only through the service-role client, behind
`assertSystemAdministratorWorkspaceAccess` or a `CRON_SECRET`-checked route. **The ledger is never
pruned** — `app_error_events` is pruned at 90 days, and the ledger is what keeps the history.

## Who may set a status

`system_audit_transition_status` is the only way a status changes:

- **A Super Admin** may set INVESTIGATING, NOT FIXED, NO DEFECT (a reason is required), UNKNOWN, and
  FIX IMPLEMENTED — the last only with a commit that is a live release (`release_gates`).
- **Only the verifier** sets FIXED — VERIFIED: 7 days with no recurrence after the fix went live, plus
  real exposure (an affected person opened that page again, or the detector held 3 nights running).
- **A recurrence on a build at or after the fix reopens the issue as NOT FIXED.** A stale tab on an
  older build (`pre_fix_build`) does not.
- The reviewed historical seed may record a fix with its merge time and evidence.

A merged PR, a green build or a deploy is never, by itself, "fixed".

## The page function and its measured speed

`system_audit_page(filters, sort, limit, offset, after)` serves both the screen and the export and
returns ONE jsonb value, so PostgREST's hidden 1,000-row cap never applies. The screen pages by offset
(capped at 10,000; past that the page asks to narrow the filters). The export walks a keyset on
`(occurred_at, id)` in 5,000-row batches and carries no total — the export counts what it wrote.

Measured on staging with 100,000 synthetic rows (210 people, 2,000 signatures, 90 days, 30% with no
person, 15% correlated), 23 Oct 2026, after the rewrite that carries the filtered set narrow, counts
columns 10–11 with hash aggregates, and sorts top-N instead of numbering every row:

| Call | Before | After |
|---|---|---|
| First page, 90 days | 2.0 s | 0.6–0.7 s |
| Filtered page | 0.4 s | 0.2 s |
| One person | 0.25 s | 0.1 s |
| Row 10,000 | 2.65 s | 0.6 s |
| Search | 1.2 s | 0.9 s |
| One 5,000-row export batch, database time | ~4.9 s | 0.6–1.4 s |

None of them spilled to disk at `work_mem = 32MB`. The function pins
`plan_cache_mode = force_custom_plan`: every filter is a plpgsql variable, and a cached generic plan
could neither drop the unused filters nor use the partial indexes' `not is_test`.

Columns 10 and 11 from this function equal the TypeScript copy the historical run uses
(`src/lib/system-audit/period-counts.ts`): 1,237 rows compared on the same 100,000-row set, across
eight filter shapes (whole period, one person, two people, system rows, shared, unique, a 20-day
Cairo window, a window with one person), 0 mismatches. The synthetic rows were deleted afterwards.

## Export

CSV (UTF-8 with BOM) and XLSX of **every filtered row**, never the visible page. Every text cell goes
through `src/lib/export/spreadsheet-safe.ts`, which neutralises a leading `=`, `+`, `-`, `@`, a tab, a
carriage return, leading whitespace and the full-width `＝＋－＠` with an apostrophe. The older per-file
guards tested only the first character, so a leading tab or space let a formula through. Every export
writes an `audit_logs` row.

## The detectors

All live in `src/lib/system-audit/detectors/` and share one shape: they read a source, write findings
through a sink (the database for the nightly sweep, a file for the historical run), and report what
they scanned and what they excluded as noise, per class. A source that cannot be read makes the run
`partial` and its findings UNKNOWN — never a pass.

| Detector | Finds |
|---|---|
| `app_error_fold` | Errors shown to a person (`app_error_events`), folded into one row per operation. Noise is excluded and COUNTED per class: development rows (a null environment is kept), a masked "Script error." with no app frame, exact browser network messages, benign disconnects, stale-deploy chunk errors that recover on reload, test accounts. "Connection closed." and third-party-only stacks are kept, the latter as PROBABLE "third-party script". The signature is versioned and engine-neutral (Chrome, Safari and Firefox spellings of one null access are one key); client chunk hashes never enter it |
| `reconciliation_ledger` | Stores every nightly integrity run (all 22 checks) and turns each breached or unanswered check into findings — per person when the check names people, capped at 500 with the remainder counted. Known-open checks are NOT FIXED with their recorded cause |
| `sync_runs` | Failed iReports360 sync runs, and runs stuck "running" for over 2 hours. A failure verifies itself once a later successful run covers its dates |
| `job_failures` | Failed background jobs (tied to the person who asked) and missed scheduled-job heartbeats. Heartbeats keep only the LAST outcome, and the coverage note says so |
| `data_linkage` | A login with no access profile, a missing attendance device map, a vacancy whose holder disagrees — one finding per person (moved here from the retired Data Health page) |
| `visit_lifecycle` | A saved Phoenix CRM visit that did not reach every module that should count it: saved → countable → served by the visits door → after the duplicate and departed-agent rules → Private Calendar → KPIs. The first failing stage is the root row; later modules add linked rows on one correlation id, so one lost visit counts once. Every business-rule exclusion (team not started or stopped, off-plan pending or refused, recording not approved, unvalidated customer, departed agent, repeat save, partnered visit, test rows, today) produces NO row and is counted |
| `verifier` | Sets FIXED — VERIFIED and reopens as NOT FIXED, by the rules above |

## The nightly sweep and the one daily message

`/api/cron/system-audit-sweep` (heartbeat slug `phoenix-system-audit-sweep`) runs at **04:57 Cairo**,
after the 04:40 integrity run, with a 240 s budget. Detectors run one at a time under a lease; the
sweep stops at the first database timeout or 5xx (`aborted_db_unhealthy`) and skips the night when the
database restarted in the last 30 minutes. It never logs a finding through `logAppError`.

It then sends **at most one message a Cairo day**, in-app and Telegram, to the
`weekly_system_health_digest` audience (key kept; label now "System health alerts") — only when an
issue is new, newly shared (its people count went from 1 to 2 or more), reopened, or a new integrity
breach. Its button opens `/admin/system-audit`. The separate nightly breach alert and the Sunday
digest are retired; the urgent alarms on the same audience (outbox drain, stranded job, database
restart, AI credit) stay separate and now link here.

## The historical run

`scripts/system-audit-historical.ts` runs the same detectors through the file sink, reading app errors
from a CSV snapshot so rows pruned since are not lost. It prints the database host, refuses 09:00–17:00
Cairo (heavy production reads wait for the evening), and refuses an unknown flag. A dry run writes
`MASTER_ERROR_AUDIT.csv`, `excluded-noise.csv` and `coverage.json`; `--apply` writes the ledger, applies
the reviewed triage seed (`src/lib/system-audit/triage-seed.ts`), marks what the first daily message
must not repeat, and sets the watermarks so the nightly sweep continues from there.

## What it replaced, and why

Measured on production, 23 Oct 2026:

- **System Issues** (and its Error Monitor alias): "Resolved" meant the next deploy happened, and a
  failed read marked every row resolved; client errors carried the release stamped at ingestion;
  module labels were "Other", "Api" and "AI" (38% of rows), not sidebar rows; 24% of rows were the
  browser's masked "Script error."; retries counted as separate errors; four counts stopped at 1,000
  rows without saying so; dates were cut at UTC midnight. Its login-security lens, Block IP and the
  repro trail moved here; the AI summary and explain, the deploy timeline and "notify employee" did
  not. The CEO no longer sees it.
- **Monitoring**: its "24 h" email figures were the latest 20 rows; the backlog card read 0 while the
  queue grew; "Recruitment activity" read a dropped table; failed reads showed as 0 or 100%; its CSV
  stopped at 1,000 rows in UTC.
- **Data Health**: six queue cards filtered a list that never holds those kinds, so they could never be
  non-zero; the health rate subtracted one population from another; pharmacy-map coverage read 100%
  when its read failed; salary flags stopped at 500. Role Coverage moved here intact, and Salary
  flags moved with the cap and the "show resolved" reset fixed.

All four old addresses redirect to `/admin/system-audit`.
