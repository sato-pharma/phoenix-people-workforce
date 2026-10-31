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
| `visit_lifecycle` | A saved Phoenix CRM visit that did not reach every module that should count it: saved → countable → served by the visits door → after the duplicate and departed-agent rules → Private Calendar → KPIs. The first failing stage is the root row; later modules add linked rows on one correlation id, so one lost visit counts once. Every business-rule exclusion (team not started or stopped, off-plan pending or refused, recording not approved, unvalidated customer, departed agent, repeat save, partnered visit, test rows, today) produces NO row and is counted. Four more checks, each its own row: the KPIs call rate counting MORE than the rules allow (`VISIT-S5-EXTRA`; a visit still in motion, or one an earlier stage already reported, is tolerated, never counted against it); a seat that moved teams, where the view judges by today's team (`au.seats.parent_seat_id`) and the team in the dated seat history (`au_v_seat_occupancy_all`) on the visit day decides the other way (`VISIT-S2-TEAMMOVED`, PROBABLE — a move both teams agree on is counted); a manager's own visit reaching `crm_visits_unified` — a legacy no-rep row credited to someone other than the manager (`VISIT-MGR-LEGACY`; credited to the manager it stays, as ruled), or a single visit from `phoenix_crm_manager_visits` served at all (`VISIT-MGR-PLAN`), read over the last 7 days on a cron run; and the view itself is probed once a run (`probeCrmVisitsUnifiedView`), because the read door answers `[]` for a missing view — when it does not answer, every door read is UNKNOWN, never "nobody visited" |
| `user_screens` | The screenshots of every error or block a person met (below), folded into one row per operation, family `user_screen` |
| `verifier` | Sets FIXED — VERIFIED and reopens as NOT FIXED, by the rules above |

## What the person saw — the error screenshot

**The owner's decision, 23 Oct 2026:** *every single type of error or block* a person meets leaves a
SCREENSHOT of exactly what they saw. It is shown **as-is (never blurred), to the Super Admin only**, on
this page, and **kept 90 days**. A *block* is the person trying to do something and being refused (a
visit save refused, a validation refused); an *error* is a request that failed or an error screen that
was shown. The in-progress "checking…" state is never photographed — only the outcome.

**What is captured.** `src/lib/error-monitor/screen-capture.ts` wraps `window.fetch` once (installed by
`GlobalErrorReporter`, production builds only — a local `next dev` writes production, so it never
installs there). A same-origin `/api/` request that answers **4xx** is a *refused request*; **5xx**, or
no answer at all (a network failure), is a *failed request*. About 900 ms later, once the page has drawn
the refusal, the visible viewport at its scroll position is drawn with `html-to-image` (JPEG, quality
0.6, at most 1.5× pixel ratio; one smaller redraw if it is over 1.2 MB) and posted to
`/api/errors/screen` with the words the response carried (JSON `message`, else `error`, else `detail`,
≤ 500 characters, read from a clone). An *error screen* (a crash) is NOT photographed here: the crash screenshot
(#6358, `/api/errors/client/screenshot`, docs/observability.md) already takes it on the error row itself,
guests included, and the incident drawer shows it under "What the employee saw". This door covers what
that one cannot see — a person refused or failed without a crash. The wrapper returns the caller's own promise untouched, never
retries, never delays it and never throws.

**Never captured.** A hidden tab; a request the page cancelled itself; a request with NO answer whose
page was out of sight at any moment between sending and failing (`noAnswerHappenedInSight`, 31 Oct 2026:
a locked phone kills the plan board's saves in flight, the failure reaches the page once it is back in
sight and working, and the board's own retry then saves — five pictures of a failure nobody met; a
refusal or a 5xx is an answer the page drew and is still photographed); the browser offline; a GET or
HEAD answered 404 (that is a page asking "is there one?", not a block); anything past the per-tab
throttle (the same kind + masked path + status once in 2 minutes, 12 pictures a tab an hour); anything
while the **outage pause** runs (below); and the
skip list `SCREEN_CAPTURE_SKIP_LIST` in `src/lib/error-monitor/screen-capture-rules.ts` — the error
reporters themselves (`/api/errors/*`, this endpoint included), sign-in and the heartbeat
(`/api/auth/*`), page-view tracking (`/api/activity/*`), the live activity poll, the notification
bell's poll, the sidebar layout and badge counts (`…/pending-count`, `…/needs-action-count`,
`…/unbooked-count`, `/api/approvals/badge-counts`), the CRM touch-trail beacon, and the health checks.
**Not captured either:** a server action or route that answers **200 with an error in its payload** —
nothing in the HTTP answer says it was a refusal, so only a status of 400 or more is one; and a refusal
shown by the page without any request at all (a form's own validation). An inner scrolled panel is drawn
from its top: `html-to-image` copies the page, not a panel's scroll position.

**The outage pause** (owner, 23 Oct 2026: "pause screenshot uploads while the server cannot store
them"). During a database outage every request fails, so every open tab, a rep's phone on mobile data
included, drew and sent up to 12 pictures an hour (each up to 1.6 MB) that the intake answered 503 and
threw away. Now an upload answered **5xx, 429 or not at all** pauses the whole browser: nothing is drawn
or sent, before the throttle and before the page is drawn. The first pause is 5 minutes, and each
refusal after it doubles it, up to an hour. A `Retry-After` is honoured up to that hour, so the
intake's own 429 waits the hour. One picture stored ends it. 400, 413, 401 and 403 are about that
picture or that session and never pause. The pause is shared by every tab through localStorage
(`phoenix:screen-upload-pause`); a tab whose storage is blocked keeps its own. Rules:
`nextUploadPause` in `screen-capture-rules.ts`; the send: `uploadScreen` in `screen-capture.ts`.
Pinned by `tests/screen-upload-pause.test.ts`.

**Stored.** `/api/errors/screen` takes a signed-in caller only (a guest gets 401 and nothing is kept),
same-origin, a body of at most 1.7 MB, a real JPEG or WebP of at most 1.2 MB decoded, every string
capped (`src/lib/error-monitor/screen-intake.ts`), and at most 40 pictures a person an hour, counted from
the table. The file goes to the private bucket `user-error-screens` at
`<Cairo yyyy-mm-dd>/<HR ID or login>/<id>.jpg` and the row to `public.user_error_screens` (migration
`20261023203000_user_error_screens.sql`: RLS on, service role only). A test account's picture is filed
under its own login with `is_test` set, never under the employee it mirrors. The picture is never
logged.

**Shown.** The nightly `user_screens` detector folds the rows into the ledger: the signature is the kind,
the API route with record ids masked (the page, for an error screen), the status and the message's
template; one person's screens of one signature within 10 minutes are one operation. Column 6 is the
exact words captured — "Error screen shown — <message>" for an error screen, and a sentence saying the
answer carried no words when it carried none. The module is the sidebar row of the page the person was
on. The row drawer shows the pictures ("What the person saw"), streamed by
`/api/admin/system-audit/screens/[id]` behind `assertSystemAdministratorWorkspaceAccess`, never cached.
**Every picture opened is logged** (owner, 23 Oct 2026: "log every screenshot view"): before the picture
leaves, `recordScreenshotView` (`src/lib/system-audit/screenshot-views.ts`) writes one
`system_audit_screenshot_view` audit row — who looked, whose screen it was (by name), the kind, the page
and when it was taken. The crash picture's signed URL writes the same row when it is minted. A refused
caller or a picture past its 90 days writes nothing. Pinned by `tests/system-audit-screenshot-views.test.ts`.
**An error screen and the `app_error_fold` row for the same crash may both appear** — one is the
picture, the other the error the browser reported; that is expected.

**Kept 90 days.** The nightly sweep — not a cron of its own — removes at most 1,000 pictures a night older
than 90 days, never one past the detector's watermark (so each is in the ledger before it goes): the
file through the Storage API first, its row after; a file that will not go keeps its row for the next
night. The counts are in the `user_screens` run's report (`retention`). The ledger rows stay; the drawer
says how many of an occurrence's pictures have passed their 90 days.

**A night that stops at the 1,000 cap raises an issue** (owner, 23 Oct 2026: "alert when the nightly
screenshot removal hits its 1,000 cap"). The removal reports `capped` and, only then, counts the pictures
still past the cutoff (`remaining`; null when that count fails, never 0). If any remain,
`buildRetentionCapFinding` (`src/lib/system-audit/detectors/user-screens.ts`) writes one issue,
"Screenshot removal hit its nightly cap of 1,000", with one occurrence per Cairo night, before the
sweep's morning message reads the board, so the message carries it the first night and again only
if it is reopened. A full batch that left nothing behind raises nothing. The run report records
`retentionAlert` (`raised`, `none`, or the write's error). Pinned by
`tests/user-error-screens-retention-cap.test.ts`.

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

A person already told today is **not asked again**: the sweep reads the day's notice (its event key is
`system-audit-daily:<Cairo day>:<HR ID>`) and its deliveries first. The idempotency key alone stops a
second delivery but still lets the refused call rewrite the stored notice — title, body and sent time,
which the in-app bell shows — with text that was never delivered: on 23 Oct 2026 the 10:56 message
listing 365 issues was overwritten by an 11:53 re-run reading "3 issues". If that read fails, the sweep
sends as before. Pinned by `tests/system-audit-daily-message.test.ts`.

## The historical run

`scripts/system-audit-historical.ts` runs the same detectors through the file sink, reading app errors
from a CSV snapshot so rows pruned since are not lost. It prints the database host, refuses 09:00–17:00
Cairo (heavy production reads wait for the evening), and refuses an unknown flag. A dry run writes
`MASTER_ERROR_AUDIT.csv`, `excluded-noise.csv` and `coverage.json`; `--apply` writes the ledger, applies
the reviewed triage seed (`src/lib/system-audit/triage-seed.ts`), marks as told **only the issues the
run itself made waiting** — an issue already waiting for the daily message before the run is a live
finding nobody has been told about, and stays for the next message — and moves each watermark forward
only (`merge: "max"`), so the nightly sweep continues from wherever is further on. Occurrences merge on
their dedupe key (`<signature>:<person>:<first event id>`), so history the live sweep already folded is
merged, not doubled. Pinned by `tests/system-audit-historical-runner.test.ts`.

## The 31 Oct 2026 digest, triaged

The 04:57 message of 31 Oct 2026 led with four items; PR 6699 fixed those. The rest, one line each.

**Fixed** — each pinned by a test that fires when the fix is removed:

- **A second press on your own off-plan decision** — 7 "already decided" and 7 "waiting for SFE" refusals,
  each seconds after the same person's own press. The repeat is answered with where the visit stands.
  `tests/phoenix-crm-unplanned-visit.test.ts`.
- **Approve on a card waiting on a Place Check** — the SFE Manager was refused 17 times, 25–29 Oct. The
  card says it waits on the check and draws no Approve. `tests/phoenix-crm-google-place-check.test.ts`.
- **"We don't have your area on file yet" during an outage** — in the 29 Oct 14:04 outage a timed-out
  area read came back as "no area" for a rep whose area is on file. A failed read now reads as a failure.
  `tests/medical-rep-monthly-closing.test.ts`.
- **The organogram popup's CV check** — 18 refusals for a Training Manager, one per person opened; the CV
  route admits only its reader roles. The page tells the popup whether the viewer may read CVs, and it
  asks only then. `tests/organogram-seat-cv-notice.test.ts`.
- **"Upload proof" offered to people the server refuses** — the Approved marketing list offered the
  money-transfer proof upload to every viewer; the server accepts it from Finance Manager and Super Admin
  only. Everyone else sees the proof on file, or "Finance attaches it". `tests/marketing-proof-upload-offer.test.ts`.
- **An outstation Meeting or Other claim priced before its amount** — the phone wizard asked for the
  calculation once the dates were set, and the server refused it for the missing amount. It waits for
  the amount now. `tests/outstation-non-travel-expense.test.ts`.
- **Brave on iPhone** — 27 + 1 rows from the browser's own wallet shim and ad-block poller, five issues.
  New rows leave the audit as `browser_injected_script`; the five existing issues stay until closed on
  the page. `tests/system-audit-noise.test.ts`.
- **The heartbeat 500 on Cloudflare's plain 502 page** (26 Oct 22:10 and 30 Oct 17:03 Cairo) — the page
  names no host, so the outage check missed it and the heartbeat crashed instead of answering 503.
  `classifyCloudflareGatewayPage` covers it for the heartbeat only: the every-sink classifier still needs
  the Supabase title, because the AI provider sits behind Cloudflare too. `tests/supabase-unreachable.test.ts`.

**No change, and why:**

- "Balance-settled days lookup failed" — one timeout, once; it did not repeat.
- "No deliverable address" for two employees — their Employee Master records hold no Sato work email.
  Data, entered in Employee Master, not code.
- "Minified React error #441" for one person — not proven to be the session-unavailable digest the
  reporter already skips (`isSessionVerificationUnavailableDigest` reads the error's own digest); left open.
- The plan 409s and plan limits, the list and validate refusals — the server refusing what it should.
  "No answer" leaves the audit since PR 6699.
- Everything else in the message is the 29 Oct 14:04–14:09 Cairo database outage.

## Today's errors, 31 Oct 2026

The errors new since that message, read the same afternoon. None of the faults PR 6699 and PR 6702 fixed
came back.

**Fixed** — each pinned by a test that fires when the fix is removed:

- **A third visit before validation, refused only after it was written** — 21 refusals from 7 reps in one
  day. Add visit now counts the same visits the save counts, lists the customer with "Validate first" and
  the save's own sentence, and does not offer the visit; a link to him lands on the same sentence. The
  save still refuses. How: `loadVisitForm` reads `loadUnvalidatedVisitCounts` (the rep's form only, one read
  per 100 customers, the save's own filters) and sets `validateFirst` on each customer; `AddFlow` stops at
  both the `open` step (a link, Today's stop) and the `form` step. `tests/phoenix-crm-unvalidated-visit-cap.test.ts`,
  whose section 4 fails if the form's count drops any filter the save's count carries.
- **"Fetch is aborted" on iPhones running iOS 16** — 108 rows from two reps in 30 days, 24 of them today.
  The stack is Phoenix CRM's own `abort()` as a screen closes; Safari on iOS 16 raises the cancelled read
  as an unhandled rejection. The browser reporter no longer files a request the page cancelled itself,
  and the audit drops the rows old tabs still send as `benign_disconnect`. A timeout is still reported.
  `tests/benign-client-disconnect.test.ts`, `tests/system-audit-noise.test.ts`.

**No change, and why:**

- "Minified React error #418" on Employees — 35 times since 26 Oct from the health-check sign-in, every
  three hours, and 6 times from one HR Administration user on 28–29 Oct. Never the owner. The code read
  found no cause, and the page was not opened in a browser to find one. **Found, not fixed.**
- "Minified React error #441" on Expense Submissions — one District Manager, 29 Oct 11:28, with no digest
  and no server error beside it. Without a digest it appeared 3 times in 30 days, on 3 pages.
- "Minified React error #412" on Weekly Sales — the page's stream closed ("Connection closed."), once.
- "Load failed" and "Error in input stream" — already counted as network noise.
- 22 rows of a masked script error with no frame of ours — excluded as `masked_script_error`.
- "Could not load map/util" — Google Maps' own loader, one rep, one moment.
- The recruitment mailbox intake — one connection timeout, at 06:14; it did not repeat.
- The geofence, duplicate-name, day-limit and nameplate refusals — the server refusing what it should.
- "No deliverable address" — two active Medical Reps still have no Sato work email in Employee Master.
  Data, entered there, not code.

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
