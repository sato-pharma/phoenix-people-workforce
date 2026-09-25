---
name: crm-single-source-door-guardrail
description: "CRM single-source door is enforced by a guardrail test; CI's pull_request checkout tests the merge-with-main, so consumers added on main get caught even if the branch is behind."
metadata: 
  node_type: memory
  type: project
  originSessionId: 76130c78-51c5-4485-975a-3e70161783c6
---

Phase 3 of the CRM single-source module is COMPLETE **and LIVE IN PROD**. PR #1072 (centralization,
`0ea29ddb`) merged to main + prod 2026-07-17 20:39Z. PR #1119 (audit fixes #1-4, `e87c0ea1`) merged
2026-07-17 23:33Z, prod revision `phoenix-hr-00046-xul` @ europe-west3. Every module reads
iReports360 CRM data through `src/lib/crm/reads.ts` — no file outside `src/lib/crm/` runs its own
`ireports360_*` query.

**Audit fixes #7-#10 + R1-R4 + #9-C/#9-D (PR #1136, merge `cfda7a14`, LIVE in prod 2026-07-18 rev
phoenix-hr-00076-ber):** #7 casing-safe door (`expandHrIdFilterValues` via `hrIdLookupKeys` — the
door matches hr ids case-insensitively; dropped the fragile home-snapshot UPPER-guess + redundant
emp-360 sprays; new `tests/crm-reads-hrid-casing.test.ts`). #8 `tickDvCheckboxesFromSync` was a
silent no-op (lowercased ids vs UPPERCASE `.in()` on app_auth_users/employees) → now expands via
hrIdLookupKeys. #10 the WIDE reconcile cron now also runs `tickDvCheckboxesFromSync` +
`syncProbationDvDays` over its slice window (DVs >10d old reached DV Analytics but not probation).
R2 FWC approved-decision conflict guard compares `employee_code` canonically (money-safety). R1
rep-day `kind` 3-way (0=Regular/-8=Campaign/else=Other). R3 getUnmappedCrmIdentities also drops the
static resigned list. R4 isCrmSchemaMissingError no longer swallows a missing-COLUMN (42703/PGRST204)
as schema-missing. **#9 owner directive = "guarantee 100% complete, don't flag":** getDistinctVisitTypes
(was 5k cap, hit every window → false-alarm) + getVisitAgentNames (25k) + reads/master
attachNearestCheckins (20k) all converted to full keyset / queryCheckins complete scans. Master
triples/vacations keep a 60k backstop + honest banner (never hit at real volumes). All source-invariant
assertions live in tests/visits-report-sync.test.ts. Worktree `_wt-crm-fixes-3` (+ merged `_wt-crm-fixes-2`)
await CLEAN.

**Deep data-fidelity audit A/B/C (PR #1156, commit `920d6f11`, branch `codex/crm-audit-fixes-4`,
worktree `_wt-crm-fixes-4`, OPEN 2026-07-18 — merge/deploy NOT yet approved):** the deep audit
(every CRM-linked module's numbers vs the CRM module) found time-collection 100% correct and
employee↔CRM mapping 99.98% (6 roster gaps = OWNER action, not code: unmapped agents Hossam Reda
crm 1184, Ahmed.Amin crm 1535, Dr Ezzat Sedrak crm 1496 [likely doctor mis-logged]; + set crm_id on
field-force Ahmed Mohamed Nagy PD-0006, Abdelrahman Alaa AI-0004, Soaf Atef AI-0003). Three module
divergences fixed: **A** employee-360 summarizeVisits/buildDoubleVisitHistory/TM-DV dates were
counting ANY `double_hr_id` on ANY visit_type as a DV (inflated + dropped unmapped-partner DVs) →
now canonical `isCrmDoubleVisitRow` (`double_crm_id≠0 AND visit_type∈{0,-8}`), added `double_crm_id`
to projection + new test employee-360-double-visit-count. **B** `tickDvCheckboxesFromSync` had NO
probation-window check → could tick a checkbox the authoritative `probation_dv_days` rejects as
outside_probation_window; now gates each DV on `[hire_date, probation_end_date]` via the SAME
`withinWindow` (newly exported from intelligence/dv-validation.ts). Window START = employees.hire_date
(from the existing employees query), END = employee_probation.probation_end_date. Deferred (separate
probation-domain change, overlaps codex/probation-dashboard-desync): legacy `employee_probation` vs
new `probation_cases` cohort + CNS-mechanism reconciliation. **C** NO number change — the company
vacation report's `visit_type=-4`-only + "AV=full day face value" are OWNER-CONFIRMED (module doc);
the master Vacations tab's raw `ILIKE '%vacation%'` + ampm→0.5 is the raw view. Fixed the SILENCE
only: bidirectional docs on crm/master.ts computeVacationPeriods + company-vacation-report.ts. Open
owner decision (non-blocking): should the report honor an AV ampm half-day as 0.5 (currently 1.0)?
Full local gate GREEN (typecheck/lint/408 tests/clean build). NOTE: local `next build` hit the known
Windows native-worker flake `0xC0000409` at "Collecting page data" on a warm `.next` — proven
env-only (clean-cache rebuild = PNPM_EXIT=0, imports acyclic); CI/Linux is authoritative. Worktree
`_wt-crm-fixes-4` awaits CLEAN.

**Audit fixes #5-6 (PR #1134, `17bf0158`, LIVE in prod 2026-07-18 rev phoenix-hr-00070-keq):**
(#5) crm/rep-day.ts `buildRepDayResult` now applies the resigned/owner exclusion (agent-side) to
BOTH live + mirror visit/check-in arms — the drill-down was excluding only on check-ins, so a DV
whose primary agent is excluded (drilled rep = partner) showed in the drill-down but no aggregate.
(#6) FWC `visitFromMirrorRow`/`loadMirrorVisitsForRange` now project + map `comment` (was hardcoded
null) so `dayHasExcuseLabeledAv` fires on the live path (40 AV-excuse rows / 19 agents were
mis-flaggable as vacation contradictions — deductions-adjacent). Deferred: rep-day non-zero→"campaign"
kind mislabel (needs a UI type change). Honest per-function scorecard artifact: claude.ai/code/artifact/03bf1c23-67ce-44f6-8994-bae9a345b13a.

**Audit fixes #1-4 (PR #1119, from the honest per-function scorecard):** (#1) reads.ts
`attachNearestCheckins` stopped anchoring on the `visit_date_time` midnight placeholder (verified
0/102,873 rows carry a real time) → now `crm_save_date`; (#2) NEW `src/lib/crm/checkin-match.ts` =
ONE canonical visit↔check-in matcher (same agent + same real contact_crm_id + same Cairo day,
tie-break crm_save_date) shared by Visits Report + CRM master tab; (#3) master DV tab uses the
canonical `double_crm_id≠0 AND visit_type IN (0,-8)` predicate; (#4) Visits Report now applies the
resigned/owner-exclusion (was the only reader still showing excluded agents). Ground-truth SQL:
iReports360 timestamps are Cairo-wall-clock stored as +00 (read as-is, timeZone UTC — never
re-convert through Africa/Cairo); crm_save_date is the ONLY real per-visit time signal.

PARALLEL-SESSION HAZARD hit while shipping #1119: main checkout was on another task's branch
(`codex/ceo-sidebar-probation`) with mixed uncommitted work. Safe recovery = patch out ONLY the
CRM-fix files, apply in a fresh worktree off origin/main, cherry-pick, verify, PR — never commit the
other session's files. See [[shared-checkout-branch-switched-midsession]].

**The lock is a real test, not just discipline:** `tests/crm-single-source.test.ts`
(`runCrmSingleSourceTests`) walks every `.ts/.tsx` under `src/` and `app/` and fails the build if
any file **outside `src/lib/crm/`** contains a `.from(<mirror>)` — string literal OR one of the
mirror-table consts (`visitsTable`, `DV_SOURCE_TABLE`, `VISITS_MIRROR_TABLE`, `CRM_VISITS_TABLE`,
…). It also asserts `crm/reads.ts` exposes the shared primitives. Wired into `tests/run-tests.ts`.

**Read primitives in `crm/reads.ts`** (the single door — call these, never query the mirror):
`queryVisits`, `queryVisitsLimited`, `queryCheckins`, `getDoubleVisitRows`, `queryVisitsPage`
(paginated+count), `scanVisitsForRange` (offset scan that preserves FWC's covering-index perf),
`getVisitAgentNames`, `getMappedAgentHrIds` (presence check, NO resigned-exclusion — used only by
the probation crmUnmapped badge), plus filters `agentHrIds` / `agentHrIdILike` / `doubleHrIds` /
`visitTypes` / `doubleOnly` / `requireAgentHrId` / `requireDoubleHrId`. All reads bake in the
resigned/owner-excluded filter ([[crm-resigned-agents-exclusion-list]] via `CRM_RESIGNED_IN_LIST`).

**KEY LESSON — CI tests the merge, not the branch head.** The `pull_request` CI event checks out
`refs/pull/N/merge` (branch merged into main), so a green LOCAL run on a stale branch can still fail
CI: main's PR #1081 (employee-360 role tabs) added a NEW CRM consumer
(`src/lib/employee-360/deep-service.ts`, 2 raw `ireports360_visits` queries) while this branch was
in flight, and the guardrail caught it only in CI. Fix pattern: `git merge origin/main` (was 0
conflicts), migrate the newly-surfaced consumer, re-run the guardrail on the merged tree. When a
long-lived branch is many commits behind main, expect the guardrail to surface consumers main added.

**Gotcha that caused the miss:** ripgrep (the Grep tool) SKIPS files it flags as binary, so
grep-based recon has a blind spot; the node `readFileSync` guardrail does not. Don't trust a
grep-only sweep to prove "no consumers left" — the test is the source of truth. See
[[localappdata-temp-is-live-tool-state]] sibling lesson on tool blind spots.

CI runs on **pnpm** (v11, [[pnpm-migration-2026-07-17]]); local `npm run test` uses
`--env-file-if-exists=.env.local` (= PROD). Isolated per-test runner used this session:
`scratchpad/p3-verify.mjs` (node + alias-loader, imports one test file by name). NOT deployed to
staging (owner didn't ask); production untouched.

**PR #1156 MERGED + LIVE IN PROD 2026-07-18 (merge `72563f88`, prod deploy run 29656919924 success,
domain 200, europe-west3 rev `phoenix-hr-00100-zev` @100%). Worktree `_wt-crm-fixes-4` awaits CLEAN.**

**Follow-on to A/B/C (owner: "complete B and C + 6 roster gaps") — commit `66e76054`, same PR #1156,
gate GREEN (clean build PNPM_EXIT=0):** Fix C COMPLETED = vacation report now HONORS the CRM's own
ampm half-day (classifyAvDate takes `ampms[]` index-aligned with comments through excuse-filter; 0.5
per AM/PM row + 1 per unmarked, capped 1.0/day; device-fingerprint <5h still forces 0.5) — REVERSED
the prior "face-value only" stance, so report + master tab now BOTH honor ampm→0.5. Fix B COMPLETED
= checkbox PM/GPM now also gates CNS via `line_name==='cns'` (matching dv-validation), not just the
NULL-column sentinel. KEY prod fact: `employee_probation` active = **0 rows** (legacy checkbox store
DORMANT); `probation_cases` (11 active) + `probation_dv_days` = authoritative cohort → NO
cohort-unification on the dead table (documented). **6 roster gaps investigated read-only on prod
`ozucdzovmcqvepbozvqf`: NOT all mappable.** The 3 "field-force employees w/o crm_id" (Ahmed Nagy
PD-0006, Abdelrahman Alaa AI-0004, Soaf Atef AI-0003) have ZERO CRM footprint (0 visits as
agent/double) → NO-OP (auto-resolve via crm_username if they ever get a CRM account). The 3 unmapped
AGENTS were APPLIED on prod (owner "go ahead"): **1184 Hossam Reda** (9 visits) mapped→A-9 (2nd CRM
account of A-9 Hossam Mohamed Reda AboElftouh, Marketing Mgr, already crm 1193) — all 9 visits'
agent_hr_id backfilled to A-9; **1496 "Dr Ezzat Sedrak"** (doctor mis-log) + **1535 Ahmed.Amin**
(admin mis-log) both set status='resigned' (off the unmapped list, resolve to no employee). Written
directly via SQL mirroring `setUnmappedCrmIdentityResolution`: upsert
`ireports360_crm_identity_resolutions` (status mapped|resigned, resolver 'phx-1' matching the 82
existing rows) + backfill agent_hr_id/double_hr_id on visits. KEY: action enum = "mapped"|"pending"|
"resigned" (crm/types.ts); the report READ-exclusion uses only the CODE array CRM_RESIGNED_AGENT_CRM_IDS
∪ live-departed, NOT the resolution table — so 'resigned' rows drop from the UNMAPPED-agents admin
list but are not code-excluded from raw master tabs (unmapped null-hr_id agents don't surface in
employee-keyed reports anyway). Real unmapped-agent gap now = 0.
