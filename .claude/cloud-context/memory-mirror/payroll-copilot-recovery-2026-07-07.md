---
name: payroll-copilot-recovery-2026-07-07
description: "Payroll Copilot \"1/10 → usable\" recovery — audit findings, the confirm/hold DB-constraint bug, and the recommendation-engine rebuild"
metadata: 
  node_type: memory
  type: project
  originSessionId: c77ebbe0-6291-4495-b1a7-b13d99435d69
---

Owner rated the shipped Payroll Copilot 1/10 (very hard, "weak AI"). Opus audited it (2026-07-07) and ran a phased recovery. Three problem layers: (1) workflow forced ~150 clicks per run, (2) the "AI" was a 9-verb command parser handed only a name, (3) quiet money bugs.

**THE headline bug (found by driving the real Accept-all flow against live data):** `payroll_copilot_adjustments.kind` CHECK constraint was missing `confirm` and `hold` — it only allowed bonus/penalty/loan/advance/prorate/override/include/defer. So **every Confirm/Accept and every Hold silently failed at the DB since launch** (swallowed by `applyActions`' try/catch): the flag looked resolved for one render (in-memory flip), then re-fired on re-assemble because no adjustment persisted; Hold never held pay. No test caught it (unit tests don't hit the DB). Fixed by migration `20260707230000_payroll_copilot_adjustments_allow_confirm_hold.sql` (widen constraint), applied staging+prod, schema_migrations reconciled to canonical version. **If confirm/accept "doesn't stick," check the DB CHECK constraint matches the app's ProposedAction kinds.**

**Recovery PRs (all off origin/main, one per phase):**
- **#935 MERGED+LIVE** (Phase 0 money): leaver settlement now includes `expenses`+incentive (was dropped — `assemble.ts` settlementAdditions); `buildApprovedDeductionTotals` filters FIELD_WORKFORCE to `no_activity` only (was deducting un-reviewed rows into `crm` column).
- **#936 MERGED+LIVE** (Phase 1 AI): new `src/lib/payroll/copilot/recommend.ts` — deterministic per-flag recommendation (action + plain-English why + confidence high/review/needs_input). NOT an LLM guess. Also added `hold` to the LLM parser vocabulary (ACTION_KINDS/schema/prompt) — it was a valid route action but unspeakable. Verified live June: 75/78 flagged are one-click "high".
- **#937 OPEN** (Phase 2 UI + the constraint migration above): merged Negotiation+Preview into one "Payroll Sheet" (deleted payroll-preview-tab.tsx); inline per-row recommendation + Accept button; "Accept all N recommendations" bar; bulk Approve-all/Reject-all on Fingerprint+CRM deduction tables.

**Deferred, need owner call on money semantics (NOT done):** leaver net/monthSalary reconciliation + false `deductions_exceed_net` block (touches locked `policy.ts` calculatePayrollParts); unpaid-vacation double-count (tab settlement + chat prorate stack — documented-intentional); silent feeder-zero on DB error → surface a warning (fold into a later UI pass). **Phase 3 planned:** conversational assistant answering "why is X flagged?" in prose.

See [[payroll-copilot-design]]. Locked files never touched: `policy.ts`, `scheme-2026.ts`.
