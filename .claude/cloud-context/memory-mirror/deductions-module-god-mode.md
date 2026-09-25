---
name: deductions-module-god-mode
description: "Unified Deductions module: MERGED then REVERTED (#1334 -> #1377) over a 300s collect timeout; where the code still lives + the day-rate divisor rule"
metadata: 
  node_type: memory
  type: project
  originSessionId: e6f0b8c9-551d-4fe5-998a-6ab6fa3f6abd
  modified: 2026-08-22T22:16:58.553Z
---

Unified "Deductions" module replacing 5 fragmented payroll-deduction calc sites
(Fingerprint, CRM, No Records Activity, Unpaid Vacation, Insufficient Balance
Vacation, Loan, Other) with one candidate ledger + publish pipeline. Full phased
plan + PR-1..PR-4 god-mode plan at
`C:\Users\satoh\.claude\plans\polymorphic-imagining-treasure.md`.

**🔴 STATUS (verified 2026-08-01): the module is NOT in the codebase — it was
merged and then reverted the same night.** #1334 merged `ef693386` on
2026-07-26 22:36 UTC; #1377 reverted it as `741a2c70` at 2026-07-27 00:15 UTC,
1h38m later. This is why `src/lib/deductions/` and `/admin/deductions` don't
exist while `deductions-governance` (a DIFFERENT, older module) does — if you
are looking for "the deductions module I built", it is in git history, not on
`main`.

**Why reverted:** `POST /api/admin/deductions/collect` returned 504 at exactly
300.001s on staging, reproduced twice. Not auth/CSRF/permissions — all four
route gates passed. Architectural: `collectAllCandidatesForMonth` runs five
company-wide scans sequentially in one HTTP request (fingerprint → crm →
no_records_activity → unpaid_vacation → insufficient_balance_vacation); each
connector is try/catch'd so a *failure* can't cascade, but nothing bounds
*slowness*. Cloud Run `phoenix-hr` is also `timeoutSeconds: 300` and prod has
more data, so production would have failed identically. Revert (not a forward
fix) was chosen because six other verified-good changes were queued behind a
paused deploy.

**The fix the revert PR prescribes:** move collection to a queued background job
— the repo already has that pattern (`/api/cron/background-jobs` drains
admin-requested exports); same shape: slow, admin-triggered, nobody awaiting the
response. Explicitly rejected: running the 5 connectors in parallel (only buys
headroom, and strains the DB with 5 concurrent company-wide scans) and raising
the Cloud Run timeout (hides it behind a multi-minute spinner). Also worth
fixing: the collect button surfaced nothing on the first 504.

**Where the code is:** commit `ef693386` — 47 files, +5,930/−17, including
`src/lib/deductions/**` (18 files), 10 API routes under
`app/api/admin/deductions/*`, both workspaces, 5
`tests/deductions-module-*.test.ts` + their `run-tests.ts` wiring, and 4
migrations. Branch `codex/deductions-module` and worktree
`_wt-deductions-module` are BOTH GONE (remote deleted by
`delete_branch_on_merge`, worktree removed post-merge) — recover with
`git revert 741a2c70` / `git show ef693386`, not by checking out the branch.

**🟡 RESTORED — PR #1571 OPEN, NOT MERGED (2026-08-01):** branch
`codex/deductions-restore`, worktree `F:/Phoenix Workforce/_wt-deductions-restore`,
based on `c5610d13`. `git revert -n 741a2c70` replayed all 47 files with ZERO
conflicts. 3 commits (`99cb600c` pure revert / `7a43f99c` timeout fix /
`0c759913` drift repairs) — split on purpose because commit 1 ALONE
reintroduces the 300s timeout verbatim and is not shippable. `check:harden`
green, pre-push gate passed unbypassed, MERGEABLE.

**Technique worth reusing:** before splitting a validated working tree into
themed commits, record `git write-tree` and back the modified files up; after
committing, assert `git rev-parse HEAD^{tree}` still equals it. That proves the
commits ship exactly what the gate validated, which splitting can otherwise
quietly break. (Also: this repo has NO pre-commit hook, only pre-push — so
`--no-verify` on a commit bypasses nothing and should never be reached for.)

**Restoring 5-day-old reverted code cost 3 drift fixes — expect more on any
future revert-of-a-revert.** Main moved underneath the module while it was out:
(1) `fetchAllRows` gained a REQUIRED `tiebreakColumn` 2nd arg and now applies
`.order()` itself — all 3 deductions call sites used the old 1-arg form
(caught by `tests/supabase-pagination-guards.test.ts`, which did not exist at
revert time); (2) generated Supabase insert types got stricter — a ternary
producing `full row | candidate_id only` now resolves to the full row with every
other column typed `undefined` and is rejected (`service.ts` decision insert,
split into two concrete inserts); (3) the collect timeout fix below. Tests run
through type-stripping so they pass while `tsc` is red — typecheck is a
SEPARATE signal, never infer it from a green test run.

**🔴 The 300s fix is NOT the one the revert PR prescribed — its suggestion does
not work.** #1377 said "move collection to the `/api/cron/background-jobs`
queue". That queue is drained by a **weekly** cron (the route's own comment says
so; CLAUDE.md lists background exports as Fri), so an HR admin clicking "Run
collection" during payroll close would wait up to a week. Instead the work is
now **bounded per request**: `DEDUCTION_COLLECTORS` is exported, the route runs
ONE connector per call via `collectOneConnectorForMonth`, and the client steps
through all five showing per-connector progress. A request with no `connector`
returns the plan instead of running anything, so the all-in-one path is
structurally unreachable from HTTP. `collectAllCandidatesForMonth` still exists
for non-HTTP callers and is doc-commented as unsafe from a request handler.
5 guard assertions in `tests/deductions-module-safety.test.ts` lock this shape;
each was verified to FIRE against `ef693386` (2 hits of the banned symbol in the
original route, 0 of the required ones) rather than merely passing.

**🔴🔴 THE MODULE HAS NEVER SUCCESSFULLY INSERTED A SINGLE CANDIDATE.** First
real production run (owner, 2026-08-01, after deploy): **0 created, 120
warnings**. `deductions_candidates.month_key` is
`GENERATED ALWAYS AS (year||'-'||lpad(month,2,'0')) STORED` and
`prepareCandidateInsertPayload` was sending a value for it ⇒ every insert died
with **`428C9 cannot insert a non-DEFAULT value into column "month_key"`**.
Proven on prod schema via a temp copy (`ON COMMIT DROP`): WITH month_key →
428C9; WITHOUT → succeeds and the DB derives `2026-07`. Fixed on branch
`codex/deductions-month-key-generated-column` (`af38bc1d`). Only this table is
affected — legacy `deduction_candidates`, `deduction_monthly_summary_lines` and
`deductions_publication_lines` all have a PLAIN month_key.

**🔴 The test ASSERTED THE BUG.** `deductions-module-foundation.test.ts` had
`assert.equal(payload.month_key, "2026-05")` — it verified the payload carried
exactly the field that makes every insert fail, and passed green through the
whole broken build. **No validation gate can catch this class — not the old local
`check:harden`, not CI today: nothing in the suite inserts against a real table.**
One owner click found what 511 test files could not. When a module's write path has
never run for real, a green suite is evidence of nothing. *(Generalised 2026-08-23:
this named `check:harden`, retired 2026-08-18. Naming the dead gate made the lesson
look obsolete when it is not — CI runs the same suite and is just as blind here.)*

**✅ FIRST SUCCESSFUL RUN 2026-08-01 (July 2026, via local dev server → PROD db):
119 candidates created.** crm 61 (61 employees, **270,209.67 EGP**), fingerprint
57 (14 employees, 26,126.87 EGP), unpaid_vacation 1. `month_key` generated
correctly on all 119 (0 nulls); 119 paired decisions, 0 orphans. Open items from
that run: **2 candidates have NULL estimated_amount** (AI-0004 crm leaver-span,
PD-0001 unpaid-vacation 0.5d) which `publishMonth` refuses ⇒ July cannot publish
until resolved; and **13 employee-days claimed by TWO categories**
(Nahed Hattab ×7 and Hossam AboElftouh ×5 crm+fingerprint, Hany Saad ×1
crm+unpaid_vacation) = double-deduction candidates the module correctly blocks.

**🔴 MY REGRESSION — parallel audit fan-out SILENTLY LOST 43 of 57 rows.**
`7e4254f2` changed audit writes from sequential to `Promise.all` over chunks of
25. `writeAuditLog` swallows its own errors, so failures vanished with no trace:
119 candidates but only 76 audit rows (fingerprint 14/57), the missing ones
scattered at RANDOM (no pattern by employee, rank, or payload size — evidence
blobs are only 210–497 bytes). Reverted to sequential in `63d37f26` + a warning
when the count is short. **Never fan out audit writes for a financial ledger;
"usually complete" is not an audit trail.** 43 prod candidates still lack audit
rows — backfill needs its own approval.

**🔴 The UI discarded the only copy of the diagnosis.** It said "120 warning(s)
— see server logs", but warnings are returned in the API response and NEVER
logged, so the logs were empty. Fixed to list the actual warning text.

**🔴 ROOT CAUSE OF THE 504 (separate, found earlier the same day) — it was
NEVER the scans. #1377's diagnosis was wrong.** Measured read-only against production: 18,539 CRM visits in July,
**3,803 attendance punches in TOTAL**, 164 employees, 29 vacation requests.
Postgres does not need 300s for that. The cost driver was
`insertCandidateDrafts` doing **4 sequential round-trips PER DRAFT** (probe,
insert candidate, insert decision, audit) in a plain for-loop. July yields
**~301 CRM no-activity candidates** (104 reps × 22 workdays = 2,288 rep-days
− 1,987 with visits) ⇒ ~1,200 sequential queries for ONE connector. This is also
why per-connector splitting alone could not fix it: candidates are NOT spread
evenly, CRM dominates. Fixed by chunking (commit `7e4254f2`): probe 200/chunk,
inserts 500/chunk, ~1,200 round-trips → ~5. Audit deliberately stays one row per
candidate (financial trail); probe fails closed; a unique-index race retries
row-by-row so one collision can't discard 499 good rows.

**🔴 #1377's premise "production would fail identically — prod carries more data
than the staging clone" is CONTRADICTED by the data.** Prod's tables are small,
and the staging where the 504 was measured was the degraded skeleton
(RLS/FKs missing until 07-31, see [[staging-is-a-schema-skeleton-not-a-clone]]),
NOT a faithful clone. Nobody ever measured production. The N+1 was real and
worth removing, but the 504 may have been a staging artifact.

**Standing lesson: size the work against real data BEFORE believing a
performance diagnosis.** Two sessions accepted "five company-wide scans are too
slow" without ever counting the rows; one read-only query showed the scans were
never the problem. Also: `.env.local` points at PRODUCTION
(see [[local-env-already-points-at-production]]), so the collector must never be
run locally to "test" it — measure with read-only SQL instead.

**🔴 DB state — CORRECTED 2026-08-01, it is the OPPOSITE of what the ledger
says.** All 4 migrations are now **APPLIED AND VERIFIED ON PRODUCTION**
(`ozucdzovmcqvepbozvqf`, owner-approved): 7 tables, RLS on all 7, 14 policies,
0 anon/PUBLIC grants, `phx_publish_deductions` service_role-only (0 leaked
grants), 3 guard triggers, 23 indexes, 7 seeded categories, 0 data rows.
Legacy `deduction_*` governance tables untouched.

**STAGING DOES NOT HAVE THEM.** Its ledger lists all 4 as applied, but
`deductions_*` tables = 0 and `phx_publish_deductions` = 0 — see
[[list-migrations-reports-ledger-not-reality]]. An earlier claim in this file
(and to the owner) that "staging has the tables, prod doesn't" was built on
`list_migrations` alone and was backwards. **Consequence: staging cannot be used
to verify this module until the 4 are applied there too** — which matters
because the per-connector timing check above is still outstanding.

**✅ search_path gap CLOSED (5th migration, owner-approved 2026-08-01).**
Applying the 4 took prod's security advisor 15 WARN → 18: three
`function_search_path_mutable`, one per trigger function
(`deductions_candidates_guard_locked`, `deductions_decisions_touch_updated_at`,
`deductions_publication_lines_guard_day_overlap`) — `phx_publish_deductions`
already pinned its own. `deductions_module_pin_trigger_search_path` applied and
verified: all three report `search_path=public, pg_temp`, advisor back to
15 WARN, zero findings naming any `deductions_*` object. Repo file
`20260801140000_deductions_module_pin_trigger_search_path.sql` (commit
`b6b89194`) rides PR #1571 rather than a standalone PR because it ALTERs
functions that only exist once the 20260725* migrations have run.

**Standing lesson: run `get_advisors` after EVERY prod DDL.** Four clean,
additive, RLS-correct migrations still moved the security lint — a schema that
verifies perfectly on tables/policies/grants can still regress the advisor.

**Shipped and pushed to PR #1334 as of 2026-07-25:** Phases 1-4 (candidate
ledger + 5 connectors, publish snapshot + atomic RPC, read-only reconciliation,
employee-portal dual-read cutover), PR-1 (all 9 safety defects: pagination,
null-amount-never-0, conflict detection wired in, manual-entry idempotency,
Overview publish predicate, approval-reason bug, supersession/correction path,
cross-month vacation clipping, fail-closed connector health), per-category XLSX
export (all 7 categories, branded Cover+Data workbook via
`src/lib/deductions/exports/category-workbook.ts`), and the day-rate divisor
correction below. PR-2 (payroll reconciliation), PR-3 (volume/bulk-decide), PR-4
(evidence drawer, pre-publish confirmation, automation) are NOT built yet.

**Day-rate divisor — FINAL rule (confirmed twice, reverses an earlier same-day
decision):** `Base Salary ÷ ACTUAL calendar days in that month` (28-31), not a
flat ÷30. Implemented via `calculateDeductionAmountFromBaseSalary` /
`resolveDayBasedDeductionAmount` in `src/lib/deductions/calculations.ts`,
reusing `calendarDaysInMonth()` from `src/lib/payroll/copilot/proration.ts` so
the two can't drift apart. Both functions now require `month`/`year`.

**Why:** owner explicitly reversed their own earlier "÷30 fixed" answer
mid-session with "the deduction is base salary / number of days of month",
reconfirmed via AskUserQuestion after I flagged the numeric-impact contradiction.

**How to apply:** this fix is scoped ONLY to `src/lib/deductions/` (the new
module), per the owner's standing "leave Automated Payroll / attendance alone"
instruction. Every other divisor site in the codebase still uses a flat ÷30 and
was deliberately left untouched: `deductions-governance/calculations.ts`,
`attendance/*.ts`, `automated-payroll/recommend.ts`,
`payroll/copilot/report-exports.ts`. Do not "fix" those without a fresh, explicit
owner decision — they may be intentionally different.

**Fingerprint is NOT affected by the divisor fix.** Its deduction amount is
sourced pre-computed, read-only, from
`src/lib/attendance/fingerprint-report.ts`'s `getFingerprintAttendanceReport()` —
the Fingerprint connector never calls `calculateDeductionAmountFromBaseSalary`
at all. That file still divides by a flat 30 internally and stays out of scope
until the owner explicitly decides otherwise.

**Architectural mandate (owner, 2026-07-25):** this Deductions module becomes
the SOLE place deductions are decided; Automated Payroll becomes 100% read-only
for deductions; any correction happens here and syncs outward to payroll. This
gates the plan's Phase 5 (Automated Payroll cutover) and Phase 6 (retiring
legacy modules), and invalidates PR-2's original reconciliation design (see
next paragraph) — do not build Phase 5/6 without re-confirming scope first.

**PR-2 (payroll reconciliation) is PAUSED, needs a methodology redo, not just a
resume.** The original design compared "governance-ledger-approved amount" vs
"actual paid amount" — but Automated Payroll doesn't autonomously decide, it
*recommends* (where it has any computation at all — 6 of its 8 deduction-bearing
steps are pure manual HR entry) and the Super Admin *confirms/edits* the number
that actually pays. So the right comparison is against the CONFIRMED amount, not
an independently-computed "expected" one. An 8-step/company-policy audit was
done (tasks #71-73 in this session, completed) but never synthesized into a
concrete change list (task #74, explicitly left paused per the owner's own
redirect toward category exports instead) — read that audit's findings before
resuming PR-2.

**Owner rule:** disputes never auto-withhold payment — only an explicit
Super-Admin "Do Not Take Action" withholds; a dispute is a flag, not an
automatic money-changer. Only the Super Admin decides anything in this module.

**Delivery discipline this owner wants:** report progress category-by-category /
piece-by-piece, never silently batch everything into one delivery; one concern
per commit (e.g. category-exports feature and the divisor fix were two separate
commits even though built back-to-back).

See [[migration-timestamp-collision-hazard]] (hit 3x building this module) and
[[preview-start-ignores-worktree-cwd]] (local dev-server verification in this
worktree).
