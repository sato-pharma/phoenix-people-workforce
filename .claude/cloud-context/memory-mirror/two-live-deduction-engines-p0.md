---
name: two-live-deduction-engines-p0
description: "RESOLVED 2026-08-30 — the deduction-engine cutover is COMPLETE: legacy governance CODE removed (C6, PR #2733) and its 7 DB tables + 2 RPCs + trigger fn ARCHIVED off public into schema deductions_governance_backup_20260830 (C7, PR #2746, on BOTH prod and staging). Only the unified src/lib/deductions module is live. The legacy deduction_* tables being ABSENT from public is EXPECTED now, not data loss."
metadata: 
  node_type: memory
  type: project
  originSessionId: 75a0c0fe-3f17-469a-aca9-812ef437e71b
  modified: 2026-08-30T01:16:20.239Z
---

**Do not re-raise this as "two engines nobody reconciled".** Validated 2026-08-13; an earlier audit
framed it that way and was wrong on three counts.

- **Canonical:** `src/lib/deductions/` → `deductions_*` (the workspace HR actually works in,
  `/admin/deductions`). Reaches payroll via `src/lib/automated-payroll/deductions-source.ts`
  (built 2026-08-03). Months 2026-07, 2026-08; last write 2026-08-11.
- **Legacy:** `src/lib/deductions-governance/` → `deduction_*`. Months 2026-05/06/07;
  **last write 2026-08-02, no August data at all** — it stopped the day before the canonical bridge
  shipped. The cutover is effectively complete.
- **`payroll_handoff_status` = "Not pushed" on all 118 rows is CORRECT, not a stalled bridge.**
  `DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED = false` in
  `src/lib/deductions-governance/feature-flags.ts` — a compile-time constant (deliberately not a DB
  flag, so it can't flip mid-run), guarded at `payroll-handoff.ts:300` and `:335`, and pinned by
  `tests/deductions-governance-payroll-import-disabled.test.ts`. It exists because the legacy import
  is strictly ADD-ON-TOP into `salary_records.crm/finger_print/unpaid_vacations` and cannot see what
  Automated Payroll already wrote — reopening it would silently pay twice.
- **Never quote a July "EGP 1.87M" exposure.** That sums `estimated_amount` over all 1,663
  candidates including **1,490 Pending**. Real July money *applied* on the canonical engine is
  **EGP 5,967.73** across 123 approved rows. Candidate estimate ≠ money owed.
- The 63 shared July employee-months and the disjoint `candidate_key` sets are **expected
  shadow-running**, documented in the flag file. Never reconcile the two on `candidate_key`.

**Two real open items (owner decisions, not engineering):** the legacy engine still ACCEPTS WRITES
via `POST /api/admin/deductions-governance/sync/all` and `.../sync/field-workforce-compliance`,
both gated on a *read* permission; and 50 canonical rows decided "Do Not Take Action" carry
`applied_amount` totalling EGP 12,612.91 (inert now, dangerous to any future consumer that sums it
without filtering on decision status).

**How to apply:** treat governance as read-only history. Full evidence:
`artifacts/phoenix-rationalization-execution/P0_SOURCE_OF_TRUTH_DOSSIER.md`. See also
[[never-auto-publish-deductions-owner-confirms-first]] and
[[deduction-raw-value-is-days-dates-is-not]].

## 2026-08-23 — the cutover finished in practice on 2026-08-02. There is ONE live engine now.

Both table families still EXIST in production, which is why a schema listing keeps suggesting two
live engines. Writes tell the real story — queried live (`ozucdzovmcqvepbozvqf`):

| family | rows | newest row |
| --- | --- | --- |
| legacy `deduction_candidates` | 206 | **2026-08-02** |
| legacy `deduction_decisions` | 118 | **2026-08-01** |
| canonical `deductions_candidates` | 1,771 | **2026-08-23** |
| canonical `deductions_decisions` | 1,770 | **2026-08-23** |

**Legacy has taken no write in three weeks; canonical is writing today.** So this is no longer an
"in-progress cutover with two live engines" — it is one live engine plus a frozen remnant that still
holds 324 historical rows.

**How to apply.** Existence is not liveness: `pg_class` will keep showing 7 legacy tables forever.
Judge by `max(created_at)`, never by the table list. The remnant is still the only home of those 324
rows, so it must not be dropped casually — but nothing reads it on a live path any more.
See [[deductions-canonical-but-legacy-has-the-only-daily-cron]], whose "legacy backs a LIVE workflow"
claim dies with this one.

## 2026-08-30 — RETIRED end to end (mossy-ocean Track C, C6 + C7). This P0 is CLOSED.

The remnant is no longer even in `public`. Both halves shipped 2026-08-30:

- **C6 (PR #2733, live rev `8004a4bec`)** deleted the whole `src/lib/deductions-governance/` code
  module — including the two write routes this memory flagged as open items above
  (`POST /api/admin/deductions-governance/sync/all` and `.../sync/field-workforce-compliance`). The
  legacy engine can no longer ACCEPT WRITES; that open item is closed.
- **C7 (PR #2746, squash `f1b25dcac`)** moved the 7 legacy `deduction_*` tables + the 2 RPCs
  (`phx_finalize_monthly_deductions`, `phx_import_deductions_governance_to_payroll`) + the trigger fn
  `phx_touch_deduction_decisions` out of `public` into schema
  **`deductions_governance_backup_20260830`**, via `ALTER … SET SCHEMA`, on **both** production
  (`ozucdzovmcqvepbozvqf`) and staging (`cifwmndunmlxjhyjugxa`). Rows preserved verbatim
  (candidates 206, decisions 118). Fully **reversible** — `ALTER … SET SCHEMA public`.

**The trap this closes:** a query for `public.deduction_candidates` (or any of the 7) now returns
NOTHING. **That is EXPECTED — the objects were archived, not dropped.** Line 60 above ("`pg_class`
will keep showing 7 legacy tables forever" in public) is now superseded: they live under the backup
schema. The inbound FK from `private_calendar_no_activity_clarifications.deduction_candidate_id` is
intact and valid cross-schema. **There is ONE deduction engine now — the unified `deductions_*`
module — and no live `public` surface for the governance one. Do not re-raise the two-engine P0, and
do not read the archived tables' absence from `public` as a bug.**
