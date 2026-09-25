---
name: outstation-payroll-notifications-dead-code
description: "SPLIT VERDICT re-verified 2026-09-04: the outstation SUBMIT notification is LIVE (notifyOutstationSubmitted, rebuilt by PR #1050, fires from 4 call sites in src/lib/outstation/service.ts). The payroll-import one is STILL dead - notifyExpensesAddedToPayroll sits at src/lib/outstation/expenses.ts:1299 and is called by nothing. Do not cite the 2026-06 'both are dead' finding as current."
metadata: 
  node_type: memory
  type: project
  originSessionId: ed35b8f5-5eb6-4d42-9da0-50c378aeda1e
---

> **RE-VERIFIED 2026-09-04 - the 2026-06-20 finding below is HALF WRONG NOW. Read this first.**
>
> - **Outstation submit: LIVE.** `notifyOutstationSubmitted` is defined at
>   `src/lib/outstation/service.ts:1388` and called from four sites (2030, 2721, 2938, 3463). It was
>   REBUILT by PR #1050 (*feat(outstation): notify Super Admin on submit*) after PR #349 removed the
>   dead scaffolding. The line below reading "the function does not exist anywhere in code" is no
>   longer true, and managers/Super Admin ARE alerted on submit.
> - **Payroll import: STILL DEAD.** `notifyExpensesAddedToPayroll` is defined at
>   `src/lib/outstation/expenses.ts:1299` and called by NOTHING. **Note the path** - PR #1031 moved the
>   expenses module out of `src/lib/payroll/` into `src/lib/outstation/`, so the file named below no
>   longer exists.
> - `notifyOutstationDecision` still fires on reject, exactly as recorded below.

Discovered 2026-06-20 while isolating the LA003 fix (see [[la003-la004-confidential-products]]) off the tangled branch `codex/sos-territory-template-registry`.

**The bug (on `main`):** `src/lib/workflow-control/definitions.ts` (~lines 197/230/313/330) documents outstation + payroll notification side effects as "Fully wired," but the code does NOT fire them:
- `notifyOutstationSubmitted` — referenced ONLY in the doc strings; **the function does not exist anywhere in code**.
- `src/lib/outstation/service.ts` `resolveOutstationApprovalRecipients` (~1273) — defined but **never called**; `submitOutstationRequest` (~1376) fires NO submit-time notification. So managers/Super Admin are NOT alerted on outstation submit.
- `src/lib/payroll/expenses.ts` `notifyExpensesAddedToPayroll` (~915) — defined but **never called** from `importApprovedExpensesToPayroll`. So employees are NOT alerted when their expense is imported to payroll.
- `notifyOutstationDecision` IS wired (called on reject ~2785) — that one works.

**Why it matters:** classic fail-silent gap — workflow docs claim notifications happen, reality is silent. High-risk areas (outstation, payroll).

**Trap to avoid:** the abandoned branch `codex/sos-territory-template-registry` commit `fa79585c` (mislabeled "fix(ci): clean unused variable warnings") took two CONTRADICTORY half-steps — DELETED the dead outstation resolver AND ADDED the payroll notify call. Do NOT cherry-pick it as-is.

**RESOLVED via PR #349 (2026-06-20, branch codex/outstation-payroll-notif-cleanup, pending merge):** owner chose option (B) — remove dead code + fix docs. Removed resolveOutstationApprovalRecipients/OutstationNotifyRecipient/outstationActionCenterUrl (outstation/service.ts) + notifyExpensesAddedToPayroll (payroll/expenses.ts) + their now-unused imports; corrected workflow-control/definitions.ts to reflect reject-only (submit auto-approves silently via approveOutstationRequestForPayroll, approve silent, payroll import silent, ONLY notifyOutstationDecision-on-reject fires) + fixed stale "fully wired" comment in workflow-control.test.ts. Confirmed the existing tests/outstation-notifications.test.ts ALREADY encoded reject-only as intended. Full gate green. Note: the spawn_task chip was also started by the user (possible parallel/duplicate session) — PR #349 already covers it.
