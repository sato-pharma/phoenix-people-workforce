---
name: nothing-blocks-a-marketing-request-after-the-ceo
description: "Owner rule 2026-08-19 — once the CEO approves a marketing request, no rung below may send it back or kill it; Finance Execution has Return AND Reject off in prod."
metadata:
  type: project
---

**Owner's words, 2026-08-19:** *"never block anything after the ceo approval — since it reached him
and he approved, [it] must be approved, never blocked."*

Applied to PRODUCTION the same day, as data rather than code:

| Row | Change |
| --- | --- |
| `marketing_workflow_steps` id=10 (`Finance Execution`) | `allow_return` true → **false** (`allow_reject` was already false) |
| The 4 open `finance_execution` approval-step rows | same, one by one |

The four: `MKT-REQ-20260814-6CD456E4`, `MKT-REQ-20260816-8E4E42C4`, `MKT-REQ-20260818-D9E88E15`,
`MKT-REQ-20260818-8C628BF4`. Closed and rejected history was left alone.

So Finance Execution is now the one rung in the chain that can only go forward — Ahmed El Maraghy
(B-185) can execute, and that is all. **Do not "restore" Return there** on the reasoning that the
other rungs have it, and do not add a new gate after `ceo_approval` for any reason.

The flags are honoured in three places and all three must keep agreeing: the decision page and the
inbox card hide what the step forbids ([[marketing-manager-chain-target-is-sales-only]] is the
sibling chain rule), and `decideMarketingRequestWorkflow` still refuses with
`marketing_return_not_allowed` / `marketing_reject_not_allowed`. The UI gate is an affordance; the
service is the authorisation.

Related: [[recording-a-marketing-decision-by-rpc-skips-audit-and-alerts]].
