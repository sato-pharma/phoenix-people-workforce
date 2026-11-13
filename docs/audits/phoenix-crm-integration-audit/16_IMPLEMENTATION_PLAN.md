# 16 — Implementation Plan

The order in which the audit's findings (report 11) and roadmap (report 10) are carried out, and where each one stands. This file is written by hand and updated in the pull request that changes a row; reports 00–15 are the audit as it was on 13 Nov 2026 and are not rewritten, apart from a sentence that was wrong about the repository itself.

Status words: **DONE** (changed and read back), **IN PROGRESS**, **PLANNED**, **OWNER** (a decision, a payment or a click that is the owner's), **NO CHANGE** (the audit's own verdict).

## Decisions taken on 13 Nov 2026 (about 16:00 Cairo)

| Question | Answer |
|---|---|
| The proposed **Integrations** page under Platform | Build it |
| A second sign-in factor for the roles that can pay people | Later, on its own, after everything else |
| Where the nightly encrypted database dump goes | The Google Drive the nightly code backup already uses |
| Settings that may be switched | Security-fix pull requests on · public sign-up off · stale CI caches deleted |
| The five audit CSV files | They stay local; `.gitignore` excludes every `*.csv` |

## Already done

| Finding | What was done | Read back |
|---|---|---|
| ISS-023 | The alert's value was a test placeholder; the fixture now builds it at run time and the alert is closed as used in tests | 0 open secret-scanning alerts |
| ISS-024 · INT-089 | Dependabot security updates switched on | `enabled: true` |
| ISS-017 | The four stale CodeQL overlay caches deleted | Actions cache 9.15 GB → 2.5 GB |
| ISS-004 | Public sign-up switched off on staging, then production | `disable_signup = true` on both |
| ISS-016 | The missing ledger exceptions and the baseline were recorded by pull request 309 | The Migration Drift Check dispatched at 16:09 Cairo passed |
| ISS-007 · ISS-008 | Each stale heartbeat row compared with the job register: six belonged to jobs that no longer exist and were deleted from production; the other four are monthly or weekly jobs that are not due yet | `job_heartbeats` 63 rows → 57, one per declared job |
| ISS-001 · INT-068 | Checked, and no change was needed: all 57 declared jobs report to the in-house heartbeat register, the 15-minute sweep alarms on Telegram for any that goes quiet, and the sweep itself is watched from outside | 57 declared, 57 reporting |
| Report 00 | The summary and pull request 308 said the folder held five CSV files; the repository holds none. The summary now says so | `00_EXECUTIVE_SUMMARY.md` |

The first Migration Drift Check dispatch that day (15:53 Cairo) was red on one new leg: 43 tables had joined the recovery undo log at 15:28 and the hourly snapshot had last run at 15:05, so they read as never captured. After the 16:05 snapshot the count was 0 on both projects.

## The pull requests, in order

One wide pull request per phase, one at a time; each is merged only on the owner's word.

### 1 — Stop silent failures — ON MAIN (pull request 317, commit `eadba666f`, 13 Nov 2026 17:22 Cairo)

| Finding | Change |
|---|---|
| ISS-002 · INT-061 | The three daily jobs the scheduler cuts at 30 seconds, and the weekly Private Calendar notice that ran to 29 seconds, answer 202 at once and finish after the response. Their verdict stays on the job heartbeat. No scheduler setting changes |
| ISS-034 · INT-070 | The alarm for a working day with no fingerprint punch already existed, in-app and by push. It now also reaches Telegram, once a day per person, never by email |

Two parts of the audit finding are deliberately not in this change. The alarm stays day-level: over the four weeks before it the first sync of a working day arrived anywhere between 10:12 and 16:17 Cairo, so a same-day alarm would fire on normal days. And it does not hold the deduction run while the feed is down: that holds money, so it is decided on the Deductions screen, not here.

ISS-001, ISS-007 and ISS-008 were planned for this pull request and needed no code; they are in the table above.

### 2 — Harden the edges — IN PROGRESS (pull request 325)

Every finding was checked against the code before anything changed. The rows below say what the pull request does; they replace the plan's first wording, which was written before that check.

| Finding | Change |
|---|---|
| ISS-015 | A CV link an applicant pastes: every redirect hop is checked before it is requested (https only, on the file-host list, five hops at most), and the body is read no further than the size cap |
| ISS-011 · INT-064 | A deadline on the thirteen outbound calls that had none: seven to Zoom, the place search, place details, the trip review's map and photo, and two to Google Sheets. No retries were added: a repeated create would book a second meeting |
| ISS-041 | The sales AI address is written out in the code (`api.openai.com` or `api.groq.com`); the two legs no environment had ever set are gone |
| ISS-027 · ISS-028 · ISS-033 | The unused websocket allowance removed; the notification drain registered as a row per door; error tracking's Node-only start explained in `docs/observability.md` and kept true by a test |
| ISS-047 · ISS-048 | Concurrency groups for the three workflows that had none; the browser cache key carries the runner image again (`playwright-ubuntu26-X64-…`, where the live keys read `playwright--X64-…`) |
| ISS-021 · ISS-057 | The runner guide and `docs/testing.md` corrected from a live read: the repository is public, has no self-hosted runner, and GitHub's own scanning is on |

Checked and left alone, each for a stated reason:

| Finding | Reason |
|---|---|
| ISS-053 | Already done before the audit: the error tracker drops every query string and the app's log redacts key, secret and token parameters |
| ISS-013 · INT-073 | The delivery webhook's provider does not sign, and a repeated event rewrites the same row, so a replay changes nothing. A freshness rule would drop the provider's own retries |
| ISS-035 | Deliberate: the browser calls the attendance agent on its own computer, which the server cannot reach, with a weaker token that unlocks one action |
| ISS-044 | No host sets the former host's variable, so the fallback changes nothing that runs; the starter images are SVG files, which are never deleted |
| ISS-045 | One package is imported by the mailbox reader; whether the other is resolved from the root by the MCP reader's build was not proven |
| ISS-020 | GitHub cannot filter a deployment event by its state before the workflow starts, and a skipped job bills nothing |

Moved out of this pull request: ISS-043 to pull request 6, ISS-025 to pull request 4, INT-006 to the sign-in pull request, and ISS-018 and ISS-019 to the owner's own list below.

### 3 — Database posture — NO PULL REQUEST NEEDED (checked 13 Nov 2026)

Each finding was read against the live database and the code before anything was written. None needed a change from this plan.

| Finding | Verdict |
|---|---|
| ISS-005 · ISS-006 | Already closed the same day by another change: the migration `service_role_only_tables_and_functions` is on production (ledger row `20261113151446`). Not repeated here |
| ISS-055 | Already exists: the System Audit board groups application errors by cause on the existing table |
| ISS-014 · INT-062 | No change. Every send step claims its row in one atomic statement, so two overlapping drains cannot send the same notice twice; a second lock would add a way to stall and nothing else. Naming one owner per route is a decision, so it moved to the owner's own list |

### 4 — Recovery — ON MAIN (pull request 338, commit `06166dbf5`, 13 Nov 2026 19:02 Cairo)

| Finding | Change |
|---|---|
| ISS-009 · INT-096 | The nightly Railway service makes a second file after the code backup: the whole production database, encrypted to the same public key, in its own Drive folder (`phoenix-db-backup`, 7 daily and 4 weekly). It connects as a new role that reads every table and can write nothing. The daily Drive check reports it under its own name, `phoenix-db-backup-verify` |
| INT-097 | A restore drill script: it restores a night's file into a new database on a throwaway server and passes only when every table holds exactly the rows counted when the backup was made. Not into staging, as first planned: the restored copy is as large as production and staging's disk would have to grow to hold it |
| ISS-025 | In the two image workflows only the job that pushes an image may write packages; every other job reads |
| ISS-038 | One rehearsal of the standby host and one of the fallback route, both recorded below |

What the rehearsals found, 13 Nov 2026:

| Rehearsal | Result |
|---|---|
| The backup and the drill on made-up data (laptop, 18:05 Cairo) | Passed: 6 of 6 tables, 5,349 rows. The drill was then broken four ways and refused each: a changed count, a table not in the dump, production named as the target, the wrong key |
| The backup read from production as the new role (laptop, 18:07 Cairo) | The role counted 1,420 tables and 5,693,881 rows and the dump ran for seven minutes without a refusal. **It was stopped by hand at 18:14**, because at 18:13 another change to production was waiting behind it for a table. That change went through seconds later. No full production file was made, so no full-size restore has been timed yet |
| What that changed | The backup now steps aside. It looks every 3 seconds for anyone waiting behind it; seen twice, it ends its own sessions, uploads nothing and tries again 10 minutes later, three times. Proven on made-up data at 18:30 Cairo: a waiting change got its table after 5.4 seconds and the backup ended with nothing uploaded |
| Every later change to the backup | `backup-image.yml` builds the real image on each pull request and runs the backup, the drill, its failures and the step-aside against a throwaway PostgreSQL 17 |
| The real image, built for the first time (GitHub, 18:36 Cairo) | Passed in 1 minute 5 seconds: the role refused an insert, a delete and a new table; the backup and the drill passed; the drill refused the wrong key, a short table, a missing table and production as its target; the backup stepped aside and the waiting change got its table after 1 second; a night retried only after a step-aside |
| The backup login (production, 18:40 Cairo, on the owner's answer "Switch it on now") | Set by `scripts/set-backup-reader-login.mjs`. Signed in through the pooler it read 566 public tables and could write to none; making a table was refused. The connection is stored on the Railway service `phoenix-code-backup` and nowhere else |
| The fallback route, rehearsed on staging from this branch (GitHub, 18:38 to 18:46 Cairo, 8 minutes 12 seconds) | Passed. GitHub built the image of main commit `426e43b0e` in 7 minutes 9 seconds and pushed it; a throwaway staging service pulled the private image with the real credentials and its container started (50 seconds); the service was deleted and none was left over. The rehearsal job held read-only package access, which is ISS-025 working. Nothing broke |
| The standby host, rehearsed from this branch (ISS-038; GitHub, 18:47 to 18:49 Cairo, 2 minutes 9 seconds) | Passed. It reused the image the fallback rehearsal had just built, started one machine in Frankfurt, and the standby's own address reported commit `426e43b0e`; the machine was then removed. The domain never moved and users never left Railway. Nothing broke. A cold run that also has to build the image would take about 7 minutes longer |

Still to do after the merge, each on the owner's word: start one run by hand, read the file on Drive, run the drill on that real file with the owner's key and write its time here, then raise the size floor (64 MB today) to half of that file.

### 5 — The Integrations page — IN PROGRESS

| Finding | Change |
|---|---|
| ISS-039 · INT-063 | A registry of every integration and a Super Admin page showing configured or not, last success and last failure, never a secret value |
| ISS-040 · ISS-042 | The transcription processor's data note and the messaging API version's review date recorded on that page |

What was built, 13 Nov 2026:

- **The registry**, `src/lib/integrations/registry.ts`: 39 outside services in eleven kinds, each with what it is used for, the names of the variables that hold its credential, and where Phoenix already records that it last worked or failed.
- **The page**, `/admin/integrations`, on the Admin Tools hub under Platform Health, for the Super Admin alone. For each service: configured, partly set (with the missing names), not configured, switched on or off, kept outside the app, or no credential needed; then the last success and the last failure in Cairo time. It writes nothing and calls no outside service.
- **Never a value, never an error's text.** It answers from variable names and shows times only. A source that cannot be read says "Unavailable"; an event Phoenix does not record says "Not recorded".
- **ISS-042.** WhatsApp messages go through Meta's Graph API v23.0, written in seven files. Meta retires it on 8 October 2027 (Meta's versions table, read 13 Nov 2026); the review date on the page is 8 July 2027. A test fails when the seven files and the registry disagree, or when an eighth appears. The audit counted six files; the seventh is the embedded sign-up exchange route.
- **ISS-040.** The voice transcription row says a clip can hold a person's name, that it goes to Groq in the United States, and what Groq's published terms say (nothing kept by default, up to 30 days of logs for a fault or abuse, no training). Whether Zero Data Retention is switched on for the company's account is **not verified**: it is the owner's click in Groq's console, under Data Controls.
- **Corrected while building.** The three live sheets (direct orders, marketing requests, the CV lifecycle) do not use the master map's Google key: each has its own address and shared key, six variables in all. They are two rows on the page.

### 6 — Provider changes — PLANNED, each needs a choice first

| Finding | Change |
|---|---|
| ISS-012 · INT-021 | The Location Integrity board moved to a tile source whose terms cover business use |
| ISS-031 · INT-041 | Standard web push in place of the vendor |
| ISS-030 | A connect prompt for Telegram at sign-in |
| ISS-043 | The joining form's font served from the app, not from a third party. It needs the font file fetched and bundled |

### Last — the second sign-in factor (INT-005) — PLANNED, on its own

INT-006 (refuse a password found in a breach) goes with it. Today a password the database's own sign-in service calls weak is still accepted by Phoenix, so refusing one is a choice about sign-in, not a tidy-up.

## The owner's own

These are not code. Each is a decision, a payment or a click on the provider's own screen.

| Finding | What it is | Where |
|---|---|---|
| ISS-021 · ISS-056 | Whether the repository stays public. Private costs CI minutes, so it is decided on GitHub, not in chat | GitHub › repository Settings › General |
| INT-066 · ISS-003 | An outside uptime monitor needs a new account with a monitoring service | The service's sign-up page |
| ISS-037 | Eight scheduler jobs on the closed cloud project | The cloud console |
| ISS-036 | The retired vendor's five jobs and four stored credential names | The scheduler and the host's variables |
| ISS-026 | The deployed edge function that has no source and no caller | Supabase dashboard |
| ISS-054 | Which production secrets stay mirrored in CI | GitHub › Settings › Secrets |
| ISS-052 · ISS-046 · ISS-032 | The non-expiring DNS token, disk encryption on the laptop, the refused error-tracking token | Each provider's token page; the laptop |
| ISS-010 | Map key restrictions and the daily quota cap | Google Cloud console |
| ISS-049 | The workflow that lives only on a side branch | GitHub › Actions |
| ISS-018 | The Actions budget the cost alarm reads. "Cannot read the budget" stays a warning on purpose; the budget value is money, and a public repository is not metered | GitHub › Billing › Budgets |
| ISS-019 | A token that may read branch protection, so the required-checks alarm stops warning that it could not read it | GitHub › Settings › Developer settings › Tokens |
| ISS-014 | One named person per scheduled route, to be told when that route fails. The routes cannot send a notice twice today, so this is only about who is told | A list of names; nothing to click |

## Not changed, on the audit's own verdict

ISS-050 (unused indexes — wait a month of statistics), ISS-051 (tables with row security and no policy — deny-all by design), ISS-029 (failed sends — a review in Email Delivery, not a change), ISS-022 (code-scanning triage — its own session, alert by alert).
