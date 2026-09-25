---
name: direct-order-chain-drops-the-whole-sales-line-silently
description: "A direct order climbs SFE -> CEO with NO sales manager on it when the requester has no manager_hr_id — the chain builder's only warning lives inside the climb loop, so it cannot fire when the loop never runs. Also: four write paths end a request OUTSIDE the chain, and direct_order_requests has no touch trigger, so updated_at can predate the row's own terminal event — never date a direct-order decision from it."
metadata: 
  node_type: memory
  type: project
  originSessionId: 38cac8f5-eef9-4ca8-9b4c-3c23b0534074
  modified: 2026-09-06T12:19:25.283Z
---

Found 2026-08-19 while sweeping every approval workflow for the [[dm-approval-chain-drops-the-ceo-never-the-nsm]] defect class. Different trigger, same damage.

`buildApprovalChain` in `src/lib/direct-orders/service.ts` climbs the requester's **real**
`managerHrId` pointers — there is no role carve-out, so it is immune to the vacation bug. But when
the requester has **no manager on record**, `cursor` starts null, the loop never runs, nothing is
pushed, and the CEO rung is appended anyway. Result: **SFE → CEO, no sales line at all.**

The trap is the logging. The "unresolvable manager" `logError` sits **inside** the loop, so it only
fires when a chain breaks *part-way up*. The one case that deletes the entire management line was
completely silent — no log, no label, nothing on screen.

**It happened for real.** Six requests on 3–4 Aug 2026, from District Managers AI-0007 (Mahmoud
Eldaly) and B-12 (Dina Hamdy), whose manager **Magdy El Senosey (AI-0008) did not exist yet** — his
employee row dates from 4 Aug 15:46 Cairo and their `manager_hr_id` was only set on 10 Aug. Five
were rejected; **`6981e8da`, EGP 4,600, was APPROVED** by SFE Manager and the CEO alone. Taha (B-94),
whose manager A-12 already existed, got his NSM rung correctly on the same days — which is what made
the two shapes comparable.

Fixed in **#2198**: flag, never block (owner decision 2026-08-19, matching this module's own
create-and-flag rule for an unresolvable manager mid-climb — refusing would stop a requester working
over somebody else's missing HR record). `directOrderChainMissingManagementLine` in
`approval-flow.ts` + a `direct_order_chain_missing_management_line` log + a rose banner on the
approval detail.

**APPLIED TO PRODUCTION 2026-08-19, do NOT undo.** Merged to `main` as `cec8399a` and **confirmed
live** — `/api/healthz` on the public domain returned that revision at 14:45 Cairo, ~2 min after the
merge, and the Railway `production` service source branch was checked as `main` (not drifted) with
`latestDeployment.meta.commitHash` = `cec8399a`. `app_error_events` recorded nothing in the 30 min
after (control: the table took 90 rows in the prior 7 days, so the zero is real). The **six**
historic requests now render the banner; no new occurrences of the log event.

**Detection is "ZERO management rungs where at least one was owed" — never a count against
`directOrderManagementLadder`.** That ladder names Regional Manager AND National Sales Manager for a
DM, but a DM reporting straight to the NSM correctly has ONE rung. Counting would flag healthy
chains. Zero rungs is always wrong for a District Manager or Regional Manager, and always fine for a
National Sales Manager (the CEO is their manager) or a Product/Group Product Manager (straight to the
CEO by design).

**Why:** a new hire submitting before HR links their manager silently bypasses their entire sales
line, and nothing anywhere says so. New people are created here constantly. Vacation and Marketing
both **refuse** this case loudly (`"Vacation approval chain is incomplete"` /
`"No approving manager could be resolved"`); Direct Orders was the only chain that shipped it.

**How to apply:** when a chain builder walks a manager pointer, the zero-iteration case needs its own
handling — a guard inside a loop cannot report a loop that never ran. Check the empty case
separately, and decide deliberately whether it blocks or flags. Related:
[[migration-file-written-is-not-migration-applied]],
[[organogram-chart-source-is-au-seat-model-not-directory]].

## A request can also END outside the chain — and `updated_at` cannot date it (2026-09-06)

Found by the approval-chain sweep that followed [[the-system-never-auto-approves-a-plan]]. Same
module, same shape as above: the chain is not the only thing that moves a request.

**Four write paths in `service.ts` set a DECIDING status directly, bypassing the chain** — a venue
ruled false (`rejectDirectOrderPharmacy`), an expired hold (`expireStaleHeldDirectOrders`), a
withdrawn hold (`cancelHeldDirectOrder`), and duplicate cleanup (`confirmDirectOrderCleanup`). Only
the last stamped `decided_at`, so **8 production rows were terminal but undated** and rendered a
blank "Decided" — 7 rejected in one venue-rejection sweep on 2026-08-05, 1 cancelled 2026-08-13.
Nothing false was ever shown: this header carries **no actor column**, so nobody could be credited
with a decision they did not make. Missing, never wrong — the opposite direction from the plan-header
bug that prompted the sweep. Fixed 2026-09-06 (`f302d27d`): `decidedStatusPatch` in
`approval-flow.ts` builds the patch once, `tests/direct-order-decided-at-stamp.test.ts` runs in the
required CI `validate` job. `reversed` is deliberately excluded — it follows an approval that already
stamped `decided_at`.

🔴 **`direct_order_requests` has NO touch trigger** (`pg_trigger` returns nothing for it), so
`updated_at` is only ever what a statement explicitly sets — and those paths set neither column.
**It can therefore PREDATE the row's own terminal event:** the cancelled row read `updated_at`
2026-08-06 while its `cancelled` event was 2026-08-13, a week later. Backfilling from `updated_at`
would have back-dated the decision and looked entirely plausible. **`direct_order_events` is the
authority for when anything happened to a request** — join `event_type in ('rejected','cancelled',
'expired','approve')` and read `created_at`. The 8 rows were dated that way; pre-image in
`direct_order_backup_20260906.terminal_decided_at_pre`.

**How to apply:** before repairing or dating any row in this table, ask the EVENT LOG, never
`updated_at`. And when auditing a workflow, remember the chain is one writer among several — sweep
for direct status writes too, because those are the ones that skip whatever the chain guarantees.
