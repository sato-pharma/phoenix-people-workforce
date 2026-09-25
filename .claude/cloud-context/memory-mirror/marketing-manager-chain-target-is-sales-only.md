---
name: marketing-manager-chain-target-is-sales-only
description: "The marketing approval chain's stop role (National Sales Manager) exists only on the sales ladder, so marketing-side submitters got the Marketing Manager and CEO twice — fixed in PR #2190 and repaired on prod 2026-08-18."
metadata: 
  node_type: memory
  type: project
  originSessionId: 37375444-88fb-4740-977c-a056555ade15
  modified: 2026-08-18T14:07:14.671Z
---

`marketing_workflow_steps.chain_target_role` is **`National Sales Manager`**, and that role exists
only on the SALES ladder. Marketing reports up a different one: `A-10 Product Manager → A-9
Marketing Manager → AA CEO → (null)`. So `buildMarketingManagerChain` never found its stop, walked
to the top of the company, and minted **"Marketing Manager Approval" at seq 1 and "CEO Approval" at
seq 2** — the exact seats `marketing_review` (seq 3) and `ceo_approval` (seq 4) already gate. Both
people were asked twice and **the CEO was asked FIRST**, before SFE Validation had run.

Measured on prod 2026-08-18: Product Manager 2/2, Marketing Manager 1/1, District Sales Manager
**0/4**. It hits PM, GPM, Marketing Manager and SFE Manager submitters (A-2 also reports to AA).

**Fix (PR #2190):** the walk now stops BEFORE the first manager whose role a later dedicated step
gates. It **stops rather than filters** — filtering would leap over the Marketing Manager and put
the CEO at seq 1, the same inversion. The gate list is **per-line** (`marketing_review_routing`
sends line 2 to Group Product Manager), so the routing lookup was hoisted above the step loop.
An **empty chain is now the correct outcome** for a marketing-side requester; the raw walk is still
checked first so "no manager at all" still fails loudly. Also stopped CC'ing the requester on their
own request.

**Applied to PROD 2026-08-18 17:05 Cairo — do NOT undo.** `MKT-REQ-20260816-8E4E42C4` and
`MKT-REQ-20260818-8C628BF4`: both `manager_chain` rungs set to `skipped` with an explanatory
`decision_note`, SFE Validation opened as `current`. A-9's 17 Aug approval on the 08-16 request is
**preserved** (`decision_by_hr_id`/`decision_at` untouched) — he simply reviews again at Marketing
Review, this time after SFE. `MKT-REQ-20260811-FF5B0719` carries the same defect but is `rejected`
and terminal — left alone.

Two things worth knowing next time: `marketing_request_approval_steps` has an AFTER INSERT/UPDATE
trigger (`phx_capture_marketing_step_event`) that writes the timeline for you, so a hand SQL repair
records itself; and [[marketing-request-events-is-the-history-table]] is append-only by trigger, so
nothing you do to the step rows can erase what already happened.

Related: [[expenses-permission-also-gates-all-marketing-requests]].
