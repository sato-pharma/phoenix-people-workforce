---
name: deductions-module-god-mode
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: Owner decisions (2026-08-01): Day rate = Base ÷ ACTUAL calendar days, EVERYWHERE. Payroll adopts the Deductions rule (payroll used ÷30) (see `start-implementing-a-plan-agile-kazoo-phase5`). Older text follows: The unified Deductions module (src/lib/deductions/**, /admin/deductions, deductions_candidates/deductions_decisions tables) — the SOLE place deductions are decided; Automated Payroll is read-only for deductions. Distinct from the older deductions-governance module. Holds the owner mandates, the day-rate divisor rule (Base ÷ ACTUAL calendar days, scoped to this module ONLY), the month_key GENERATED-column trap, and the never-fan-out-audit-writes / size-the-work-before-diagnosing lessons."
metadata: 
  node_type: memory
  type: project
  originSessionId: e6f0b8c9-551d-4fe5-998a-6ab6fa3f6abd
  modified: 2026-09-26T05:55:03.271Z
---

Unified **Deductions** module — one candidate ledger + publish pipeline replacing 5 fragmented
payroll-deduction calc sites (Fingerprint, CRM, No Records Activity, Unpaid Vacation, Insufficient-Balance
Vacation, Loan, Other). It lives in `src/lib/deductions/**`, `/admin/deductions`, `app/api/admin/deductions/*`
and 7 tables (`deductions_candidates`/`deductions_decisions`/`deductions_publication_lines`/…, RLS on all,
`phx_publish_deductions` service-role-only). It was merged, reverted the same night over a 300s collect
timeout, then restored and is now the live pipeline. **It is a DIFFERENT, newer module than the older
`deductions-governance`** (which still exists) — if `src/lib/deductions/` seems missing, verify against live
`main`/prod rather than assuming.

## Owner mandates (money-critical)

- 🔴 **This module is the SOLE place deductions are decided.** Automated Payroll is 100% read-only for
  deductions; any correction happens here and syncs outward. This gates Phase 5 (Automated Payroll cutover)
  and Phase 6 (retiring legacy modules) — do NOT build either without re-confirming scope.
- **Only the Super Admin decides anything in this module.** A dispute never auto-withholds payment — only an
  explicit Super-Admin "Do Not Take Action" withholds; a dispute is a flag, not an automatic money-changer.
- 🔴 **Day-rate divisor = `Base Salary ÷ ACTUAL calendar days in that month` (28–31), NOT a flat ÷30** (owner
  reversed his own earlier ÷30 answer). Implemented via `calculateDeductionAmountFromBaseSalary` /
  `resolveDayBasedDeductionAmount` in `src/lib/deductions/calculations.ts`, reusing `calendarDaysInMonth()`
  from `payroll/copilot/proration.ts` so the two can't drift (both require month/year). 🔴 **This is scoped to
  `src/lib/deductions/` ONLY** — every other divisor site still uses a flat ÷30 DELIBERATELY
  (`deductions-governance/calculations.ts`, `attendance/*`, `automated-payroll/recommend.ts`,
  `payroll/copilot/report-exports.ts`); do NOT "fix" those without a fresh owner decision. **Fingerprint is
  NOT affected** — its amount comes pre-computed read-only from `attendance/fingerprint-report.ts`
  (`getFingerprintAttendanceReport()`), which divides by flat 30 internally and stays out of scope.
- **Delivery discipline:** report progress category-by-category, one concern per commit.

## Durable schema and engineering lessons

- 🔴 **`deductions_candidates.month_key` is `GENERATED ALWAYS AS (…) STORED`** — sending ANY value for it dies
  with `428C9 cannot insert a non-DEFAULT value into column "month_key"`; let the DB derive it. Only THIS
  table — legacy `deduction_candidates`, `deduction_monthly_summary_lines` and `deductions_publication_lines`
  have a PLAIN month_key. 🔴 **The test ASSERTED THE BUG** (`assert.equal(payload.month_key, "2026-05")`) and
  passed green through the whole broken build. **No validation gate catches this class — nothing in the suite
  inserts against a real table. When a module's write path has never run for real, a green suite is evidence
  of nothing; one owner click found what 500+ test files could not.** (CI runs the same suite and is just as
  blind — don't read the lesson as being about the retired local `check:harden`.)
- 🔴 **Never fan out audit writes for a financial ledger.** A `Promise.all` audit fan-out silently lost 43 of
  57 rows because `writeAuditLog` swallows its own errors — the misses scattered at random with no trace.
  Keep audit writes SEQUENTIAL, one row per candidate, with a warning when the count is short. "Usually
  complete" is not an audit trail.
- 🔴 **The 504 was an N+1, NOT the five company-wide scans.** `insertCandidateDrafts` did 4 sequential
  round-trips PER DRAFT (probe, insert candidate, insert decision, audit); CRM alone yields ~300 candidates ⇒
  ~1,200 round-trips per connector. Fixed by chunking (probe 200/chunk, inserts 500/chunk; a unique-index race
  retries row-by-row so one collision can't discard 499 good rows; probe fails closed). **Standing lesson:
  size the work against REAL data before believing a performance diagnosis** — two sessions accepted "five
  scans are too slow" without counting rows, and prod's tables are small (the staging where the 504 was
  measured was a degraded schema skeleton, not a clone — [[staging-is-a-schema-skeleton-not-a-clone]]).
- **Collection is BOUNDED per request:** `DEDUCTION_COLLECTORS` is exported and the route runs ONE connector
  per call (`collectOneConnectorForMonth`), the client stepping through all five with per-connector progress;
  a request with no `connector` returns the plan, so the all-in-one HTTP path is structurally unreachable.
  `collectAllCandidatesForMonth` survives for non-HTTP callers, doc-commented unsafe from a request handler.
  Guard tests lock this shape. The revert PR's fix (move to `/api/cron/background-jobs`) does NOT work — that
  queue drains WEEKLY, so an HR admin clicking "collect" during payroll close would wait days.
- **Publish blockers (by design):** `publishMonth` refuses a candidate with a NULL `estimated_amount`, and the
  module correctly blocks an employee-day claimed by TWO categories (a double-deduction).
- **Run `get_advisors` after EVERY prod DDL** — four clean, additive, RLS-correct migrations still moved the
  security lint (three trigger functions needed `search_path` pinned). And **`list_migrations` lies about
  staging** — the ledger listed all migrations applied while the `deductions_*` tables were 0
  ([[list-migrations-reports-ledger-not-reality]]); staging can't verify this module until they're really
  applied there.
- **Never run the collector locally to "test" it** — `.env.local` points at PRODUCTION
  ([[local-env-already-points-at-production]]); measure with read-only SQL instead.

## PR-2 (payroll reconciliation) is PAUSED — needs a methodology redo, not a resume

The original design compared "governance-approved amount" vs "actual paid amount", but Automated Payroll
RECOMMENDS (6 of its 8 deduction-bearing steps are pure manual HR entry) and the Super Admin confirms/edits
the number that pays — so the right comparison is against the **CONFIRMED** amount, not an independently
computed "expected" one. An 8-step audit was done but never synthesized into a change list; read it before
resuming. PR-3 (bulk-decide) and PR-4 (evidence drawer, pre-publish confirmation, automation) are not built.
