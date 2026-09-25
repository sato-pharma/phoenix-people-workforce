---
name: audit-remediation-phase-progress
description: "Live progress tracker for the 8-phase plan resolving all 2026-08-01 audit findings — which phases shipped, what each corrected, and the follow-ups spawned"
metadata: 
  node_type: memory
  type: project
  originSessionId: e0491122-d75a-469e-8531-3c35cc29cb82
  modified: 2026-08-01T18:01:11.857Z
---

Plan file: `C:\Users\satoh\.claude\plans\majestic-orbiting-dream.md` (owner-approved 2026-08-01).
Findings source: [[module-audit-2026-08-01-status]] + [[cairo-timezone-audit-round2-2026-08-01]].

**Owner decisions for this plan (do not re-ask):** execute sequentially in one session · owner
handles live HR data (77 clarifications, 138 FWC candidates) in the app · migrations go
author → staging → **owner approval** → production.

## Shipped before the plan (all LIVE in prod, revision `phoenix-hr-00806-zoj`)
`0dcca58b` #1575 No-Activity suppression · `424386fb` #1579 outstation ticket evidence ·
`ba390854` #1585 five Cairo period seeds · `17dccd75` #1586 Cairo leave surfaces.
Also open/green at plan time: #1588 No Activity Days retirement, #1589 weekly-plan approver UI.

## Phase status
- ✅ **Phase 1 — Terminations tell the truth. MERGED `e2cd9007` (#1594).**
  Probation + contract non-renewal now pass `suppressWorkflowNotification` (they were announcing
  company decisions as voluntary resignations); `runResignationWorkflow`'s `complete` now actually
  terminates via `updateEmployeeLifecycleFallback` + `deactivateEmployeeAccessIfSupported`.
  🔴 **Do NOT "simplify" complete to call `resignEmployeeAndOpenVacancy`** — that inserts a SECOND
  `employee_resignations` row for the record being completed. Guard test:
  `tests/termination-truth.test.ts`.
  **Correction to the original finding:** the terminate RPC does NOT leave employees active — it
  deactivates at insert (`20260718210000:81-95`). Its only defect is inserting `status='submitted'`,
  which leaves a permanently-pending row driving false SLA nags → moved into Phase 2.
- ✅ **Phase 2 — Contract renewal RESTORED. APPLIED TO STAGING *AND* PRODUCTION 2026-08-01.**
  PR #1597 (`db43867c`). **It was THREE missing functions, not two** — `phx_contract_note` (the
  shared note-builder both RPCs call) was equally absent; lifting only the two public RPCs would
  have produced functions that install and then fail on first call.
  Verified end-to-end on staging first: a real request drove `requested → manager_review →
  hr_review → renewed`, creating 4 history rows + 1 `employee_contracts` row and updating the
  employee's renewal date — **the first successful renewal in the platform's history**. All
  verification data cleaned up afterwards.
  Production verified after apply: 3 functions present, `service_role` EXECUTE only (anon +
  authenticated denied), **zero rows touched** (requests/history/contracts all still 0, 166
  employees, 3 policies unchanged).
  🔴 **One extra defect found and fixed while verifying:** the archived body stamped
  `contract_signed_date` with bare `current_date` — restoring it unchanged would have recorded new
  contracts as signed YESTERDAY during the Cairo 00:00–03:00 window. Now
  `(now() at time zone 'Africa/Cairo')::date`. This is the ONE deliberate deviation from the
  verbatim archive copy.
  ⚠️ **The MCP apply 502'd on the first attempt.** Nothing had been applied (verified 0 functions
  before retrying) — **always check actual state after a 502, never blind-retry.**
  ⬜ Still owed from this phase: the 9 unzoned `current_date` functions → spawned as
  `task_2e644a4f` (see below).
- ✅ **Phase 2b — unzoned `current_date` (task_2e644a4f). PR #1600, APPLIED TO STAGING *AND* PRODUCTION 2026-08-01.**
  Production went 9 → 5 affected functions; post-apply 396 seat×period rows compared, 396 agree /
  0 differ. CI green on `ed736bc4`. **PR not merged — owner approval still required.**
  🔴 **Found while verifying: `accept_offer_and_create_employee` is DEAD in production.**
  `to_regclass('public.job_offers')` and `to_regclass('public.job_offer_audit_logs')` both return
  NULL, so it raises on its first statement and can never succeed. Pre-existing, NOT caused by the
  migration (body reproduced byte-for-byte). Same class as the contract-renewal RPCs. This means
  the headline wrong-HIRE-DATE impact **cannot currently fire** — the fix is correct but latent.
  Follow-up chip `task_231b5f44`. Tier-5 remainder chip `task_dccde67e`.
  Branch `codex/cairo-sql-current-date`, worktree `_wt-cairo-sql-dates`, migration
  `20260801180000_cairo_date_in_lifecycle_and_seat_functions.sql`. Fixes **tiers 1-4 only**:
  `accept_offer_and_create_employee` (the wrong HIRE DATE), `finalize_manual_employee_lifecycle`,
  `au.f_seat_occupant_asof`, `generate_employee_lifecycle_notifications`.
  Technique that made it safe: `regexp_replace(pg_get_functiondef(oid), '\mcurrent_date\M', …)`
  run **inside Postgres** and written straight to the file — no body retyped. Proven faithful by
  md5: staging's four post-apply `pg_get_functiondef` outputs match production's Cairo-replaced
  bodies byte-for-byte. 264 seat×period rows compared, 264 agree / 0 differ outside the window.
  🔴 **Tier 5 is MISLABELLED as cosmetic in the plan.** Three of the five vacancy-ownership
  functions store a REAL date, not note text: `phx_ensure_terminal_employee_vacancy:41`,
  `phx_reassign_replacement_ownership`, `phx_autofill_replacement_vacancy_from_employee_insert`
  all use `current_date` as the final fallback for `v_effective_date`. Only
  `phx_reconcile_stale_replacement_vacancies` and `phx_release_terminal_manager_ownership` are
  note-text only. Deferred deliberately — a parallel session owns those bodies.
  🔴 Gotcha that cost a re-apply: see [[revoke-from-public-strips-service-role-on-default-acl]].
  🔴 `tests/au-seat-occupant-resolver.test.ts` pins the resolver with **literal SQL strings** and
  resolves the LATEST migration defining each object — any migration touching `au.*` bodies will
  break it until the literals are updated. That is by design; update the literal, keep the intent.
- ⬜ Phase 3 access gates + Report-It · ⬜ Phase 4 notification integrity · ⬜ Phase 5 Cairo
  remainder (7 sites) · ⬜ Phase 6 nav reachability + parity test · ⬜ Phase 7 CI/backup safety ·
  ⬜ Phase 8 weekly-plan revise collision (migration).

## Follow-ups spawned (chips, not fixed inline)
- `task_ef3e44ee` — **completing a resignation opens no vacancy** for the vacated seat, while the
  Employees-page path does. Left out because creating one blindly could duplicate an existing
  vacancy, and vacancy truth drives the organogram / au seat model. Needs a duplicate-safe check.

## Standing notes for this effort
- Main moves fast — other sessions merged #1591, #1590, #1587 during Phase 1. **Re-cut every phase
  worktree from latest `origin/main`** and merge main in before validating if the branch ages.
- Every phase: test-first, confirm it fails on ITS OWN assertion, then fix. Two of my own guard
  tests have had bugs (a string match hitting a comment that said the opposite; an `indexOf` on a
  non-async function returning -1 and swallowing the file).
