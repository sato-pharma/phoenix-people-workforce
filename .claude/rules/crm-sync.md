---
paths:
  - "src/lib/crm/{live-poller,sync,sync-run-groups,parity,plan-sync,cutover,housekeeping-scheduler}.ts"
  - "app/api/cron/ireports360-visits-{live-sync,reconcile,sync}/**"
  - "tests/crm-live-*"
---

# Module memory — Field CRM sync — the iReports360 live poller, its scheduled jobs and their restart markers

**Scope:** The in-process iReports360 loop: the live probe, the rolling 10-day sync, the weekly 30-day reconcile, the plan sync, the contact-list sweep and the parity sweep, the order it runs them in, and the markers a deploy restart reads back so it does not run one again.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

- 🔴 **THE POLLER REMEMBERS ITS LAST ROLLING SYNC AND WEEKLY RECONCILE BY READING DEEP RUNS ONLY (`readDeepRunMarkers`, `date_from` at least 9 days back) — NEVER "THE NEWEST 200 SUCCESSFUL ROWS" OF `ireports360_visits_sync_runs`.** The live poll writes a small row per probe (20-44 an hour from 10:00 Cairo on 11 Oct 2026), so by a 17:35 deploy that Sunday the 04:00 reconcile was 231 rows back, the marker came back null and the 30-day reconcile ran again, digest included. It only shows on a Sunday after 04:00 because the reconcile is due on no other day. Pinned by the 231-probe-row block of `tests/crm-live-poller.test.ts`, whose fake applies the filters it is given.
- 🔴 **A RESTART MARKER THE POLLER COULD NOT READ HOLDS THE JOBS IT TIMES, AND IS READ AGAIN EVERY TICK — FOR 30 MINUTES AT MOST, THEN THEY RUN WITHOUT IT AS BEFORE** (19 Oct 2026, 15:21 Cairo: one marker read timed out in a database burst, a 6.5 ms query, and the first due tick would have re-run the 10-day sync it had just run; on a Sunday afternoon, the 30-day reconcile). `seedMarkers` and `nextSeedHold` in `src/lib/crm/live-poller.ts`; three groups, each its own hold: the deep runs (rolling sync and reconcile), the plan sync and the parity sweep. `resolveDueScheduledWork` takes `held`; the live poll and the contact lists are never held. A failure is a `logWarning` while held and ONE error row when the hold gives up (`SEED_HOLD_MAX_MS`), never sooner — never lengthen it, the rolling sync feeds payroll attendance. Pinned by the last block of `tests/crm-live-poller.test.ts`.
- 🔴 **ONE POLLER ACROSS EVERY PROCESS — EACH TICK CLAIMS THE `crm-live-poll` LEASE IN `public.job_leases` FIRST, AND STANDS BY WHILE ANOTHER LIVE PROCESS HOLDS IT** (23 Oct 2026 audit, P5-05). A heartbeat renews it every minute (ttl 180 s), so a long deep run never lets it lapse and a dead holder is replaced within three minutes. It FAILS OPEN: until `20261023140000_job_leases.sql` is applied, or whenever `claim_job_lease` cannot be read, every claim answers "held" — today's behaviour, said once in the log (`job_lease_unavailable`). Never make an unreadable lease stop the poller. `src/lib/platform/job-lease.ts`; pinned by `tests/job-lease.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
