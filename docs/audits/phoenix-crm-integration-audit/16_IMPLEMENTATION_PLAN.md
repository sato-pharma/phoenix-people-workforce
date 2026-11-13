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

### 1 — Stop silent failures — IN PROGRESS

| Finding | Change |
|---|---|
| ISS-002 · INT-061 | The three daily jobs the scheduler cuts at 30 seconds, and the weekly Private Calendar notice that ran to 29 seconds, answer 202 at once and finish after the response. Their verdict stays on the job heartbeat. No scheduler setting changes |
| ISS-034 · INT-070 | The alarm for a working day with no fingerprint punch already existed, in-app and by push. It now also reaches Telegram, once a day per person, never by email |

Two parts of the audit finding are deliberately not in this change. The alarm stays day-level: over the four weeks before it the first sync of a working day arrived anywhere between 10:12 and 16:17 Cairo, so a same-day alarm would fire on normal days. And it does not hold the deduction run while the feed is down: that holds money, so it is decided on the Deductions screen, not here.

ISS-001, ISS-007 and ISS-008 were planned for this pull request and needed no code; they are in the table above.

### 2 — Harden the edges — PLANNED

| Finding | Change |
|---|---|
| ISS-015 | Applicant-supplied links: host re-checked on every redirect, private addresses refused, response size capped |
| ISS-011 · ISS-053 · INT-064 | One outbound client: a deadline on every call, bounded retries, provider keys redacted from logs and error reports |
| ISS-013 · INT-073 | One verification helper for inbound webhooks, with a freshness window |
| ISS-035 | The attendance agent token stays on the server |
| ISS-027 · ISS-028 · ISS-033 | The unused websocket allowance removed; the drain's registry row corrected; the edge-runtime note or init |
| ISS-041 · ISS-043 · ISS-044 · ISS-045 | Unused AI hops, the third-party font request, former-host residue and two unused packages removed |
| ISS-018 · ISS-019 · ISS-020 · ISS-025 · ISS-047 · ISS-048 | Workflow hygiene: alarms that cannot read their input fail instead of passing, write scopes moved to the job, concurrency groups, one cache key |
| ISS-021 · ISS-057 | The runner guide and the two contradicting passages corrected |
| INT-006 | Breached-password check when a password is set |

### 3 — Database posture — PLANNED

| Finding | Change |
|---|---|
| ISS-005 | Row security switched on for the three tables that have it off |
| ISS-006 | `EXECUTE` revoked from the anonymous role on the 40 functions, with default privileges set so new functions are not granted |
| ISS-014 · INT-062 | The notification drain's overlap lock taken in the database; one owner named per route |
| ISS-055 | Application errors grouped by cause on the existing table |

### 4 — Recovery — PLANNED

| Finding | Change |
|---|---|
| ISS-009 · INT-096 | A nightly encrypted database dump beside the code backup |
| INT-097 | A restore drill into staging, with the time it took written down |
| ISS-038 | One rehearsal of the standby host, recorded |

### 5 — The Integrations page — PLANNED

| Finding | Change |
|---|---|
| ISS-039 · INT-063 | A registry of every integration and a Super Admin page showing configured or not, last success and last failure, never a secret value |
| ISS-040 · ISS-042 | The transcription processor's data note and the messaging API version's review date recorded on that page |

### 6 — Provider changes — PLANNED, each needs a choice first

| Finding | Change |
|---|---|
| ISS-012 · INT-021 | The Location Integrity board moved to a tile source whose terms cover business use |
| ISS-031 · INT-041 | Standard web push in place of the vendor |
| ISS-030 | A connect prompt for Telegram at sign-in |

### Last — the second sign-in factor (INT-005) — PLANNED, on its own

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

## Not changed, on the audit's own verdict

ISS-050 (unused indexes — wait a month of statistics), ISS-051 (tables with row security and no policy — deny-all by design), ISS-029 (failed sends — a review in Email Delivery, not a change), ISS-022 (code-scanning triage — its own session, alert by alert).
