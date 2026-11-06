---
paths:
  - "src/lib/crm/{sync-run-groups,cutover,housekeeping-scheduler,vendor-row-types}.ts"
  - "src/lib/platform/in-process-host.ts"
  - "tests/crm-cutover.test.ts"
---

# Module memory — Field CRM sync — the retired iReports360 sync's record, the cutover switch and the housekeeping timer

**Scope:** What outlived the iReports360 sync: the vendor sync-run log and its history panel, the cutover and retirement switch (crm_cutover), the in-process host guards, and the CRM housekeeping timer (contact-master refresh, probation double-visit capture). The poller and every vendor call were removed on 6 November 2026.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

- 🔴 **THE SYNC RUN LOG IS READ THROUGH `(status, started_at)` AND `(status, completed_at desc)` — NEVER DROP EITHER AS UNUSED-LOOKING** (26 Oct 2026, load audit). The reaper read all 48,182 rows for its 0 or 1 running row (36 ms, 0.1 ms now) and `readDeepRunMarkers` went from 11.9 ms to 1.0 ms. `getLatestSuccessfulSyncRunFor` stays a 10.7 ms whole-table read on purpose: 99.9% of rows are successes, so no index helps it. Pinned by `tests/db-load-sweep-skipscan.test.ts`; account: `docs/perf/2026-10-25-db-load-baseline.md`.
- 🔴 **iREPORTS360 IS RETIRED — `vendor_sync_retired_at` = 6 NOV 2026 03:16 CAIRO, ON THE OWNER'S WORD, AND ITS CODE IS GONE** ("no more accepted visits or records on old crm"). Last pull: parity 28 Oct–6 Nov 318 = 318; its rows stay and every report keeps reading them through the combined views. A module once wired to the old CRM is REWIRED to Phoenix CRM, never closed (his words, same night). Never restore a vendor call, job, button or the `IREPORTS360_*` secrets without his own words. Account and the poller's five retired rules: `docs/crm-cutover-runbook.md`, "Done — iReports360 retired".
- 🔴 **THE HOUSEKEEPING TIMER RUNS UNCONDITIONALLY — NEVER GATE IT ON `vendor_sync_retired_at` AGAIN** (6 Nov 2026). With the poller deleted it is the ONLY caller of the contact-master refresh and the probation double-visit capture; an unreadable or unset setting would stop both silently. It keeps the in-process host guards (`src/lib/platform/in-process-host.ts`, still switched by `PHOENIX_LIVE_CRM_POLL` — the name is historical, never rename or remove it). Pinned by `tests/crm-cutover.test.ts`.
- 🔴 **CLOSING iREPORTS360 NEVER SETS A CUTOVER DATE — `vendor_sync_retired_at` STANDS ALONE SINCE `20261031150000`** (31 Oct 2026). Every team already moves on its own start date; the global `cutover_date` would also pick the month decision 18 never charges, switch the KPI rules and open vacation-day requests — the owner's money decision, never a side effect of closing the API. Never re-add `crm_cutover_retire_needs_date`, never make `parseCrmCutoverRow` drop an undated retirement, and never retire while `crm_visits_unified` still serves a recent `source = 'ireports360'` row (36 active people on 31 Oct: 9 with no Phoenix visit, 27 with days recorded only in iReports360). Order: `docs/crm-cutover-runbook.md`, "Closing iReports360 when every team started on its own date". Pinned by `tests/crm-cutover.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
