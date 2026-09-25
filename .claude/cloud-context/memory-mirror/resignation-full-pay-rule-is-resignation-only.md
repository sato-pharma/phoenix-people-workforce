---
name: resignation-full-pay-rule-is-resignation-only
description: "The Ready-sheet >25th full-pay waiver is for genuine resignations ONLY; terminated/inactive leavers stay prorated with zero allowances"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a9c74c99-64f5-40dc-839c-edac1889219a
  modified: 2026-08-29T14:56:56.672Z
---

LIVE on prod 2026-08-14 (merge `0d78cb72`, PR #2126) — do NOT redo/undo.

Owner ruling 2026-08-14: Resignation Rule 1's ">25th full-pay" waiver on the Ready
Payroll sheet — last working day after the 25th → base paid IN FULL, ECOL and Fuel
kept IN FULL — applies to **genuine resignations only**. A `terminated` (dismissed)
or `inactive` (deactivated) leaver is NOT a resignation: base is prorated to the
**actual** last working day and BOTH allowances are withheld (the pre-Rule-1 leaver
treatment).

**Why:** a risk-review of PR #2126 found the waiver was gated only on "has a last
working date this month", so it fired for the whole terminal set
(`{resigned, terminated, inactive}`). A dismissal on the 28th of a 31-day month
would have been silently overpaid a full month of base **plus** ~3,500 EGP of
allowances (3,000 ECOL + 500 Fuel) that `main` withheld — with no mismatch guard to
catch it, because cached and recalculated net agreed.

**How to apply:** the Ready sheet gates on an `isResignation` flag derived from
`employmentStatus === "resigned"` (`resolveReadyLifecycleSettlement` in
`src/lib/payroll/ready-proration.ts`; wired in `app/api/payroll/template/route.ts`).
The canonical **Automated** engine keys its leavers off the `employee_resignations`
table filtered to `exit_status IN ('submitted','approved','completed')`
(`src/lib/payroll/copilot/feeders.ts`), never the broad status set — so gating on
"resigned" keeps the two engines from diverging on WHO counts as a resignation.
Residual edge the owner may still want tightened: someone manually flagged
`resigned` without an approved `employee_resignations` row still gets the waiver on
the Ready sheet. Do NOT widen the gate back to all leavers. See
[[two-live-deduction-engines-p0]].

**SUPERSEDED IN PART, 2026-08-29 (later the same day) — MERGED AND LIVE.** This note said leavers
were deliberately left on the base-only day rate when the owner moved JOINER proration onto net that
morning. He then gave the matching instruction for leavers: *"in the resignations, prorate the full
net salary, not the base."* So a genuine resignation with a last working day **≤ 25th** now prorates
Base, ECoL and Fuel at the same day share. **PR #2655, merged 17:51 Cairo as `504e187ed`, serving in
production from 17:54.** It RAISES pay — measured live against August: 15 of 23 leavers in scope,
14 gain, **+11,870.98 EGP** total, largest +2,258.06, **nobody worse off**.

**The sharpest case is not a raise, it is a ZERO being fixed.** Two August leavers — `AI-0006`
Mohamed Yasser and `PD-0007` Bahaa Gamal, both Medical Representatives — carry `base_salary = 0`
with `net_salary = 2500` made up entirely of ECoL 2000 + Fuel 500. The old rule prorated base (zero)
and withheld both allowances, so it priced five days' and two days' work at **0.00 EGP**, silently
and with no error. They now settle at 403.23 and 161.29. **When a leaver's whole package sits in the
allowances, the old rule paid them nothing at all** — so do not read this change as merely generous.
See [[people-with-no-salary-figure-are-priced-at-nothing]].

**What this note still governs, unchanged:** the `terminated` / `inactive` leaver above. A dismissal
keeps NEITHER allowance and is still prorated on base alone — prorating "net" there would hand back
precisely what the 2026-08-14 ruling withholds. The `>25th` branch is also untouched (it already paid
every component in full, so "prorate the net" is a no-op there), and so are **unpaid leave, holiday
bridging and vacation settlement**, which stay base-only: none of them is a partial month of
employment. `tests/ready-payroll-proration.test.ts` pins resignation vs dismissal apart on the same
date — the gap between them must equal exactly the allowances' worked share.
[[a-payroll-rule-change-does-not-reach-an-already-open-run]]
