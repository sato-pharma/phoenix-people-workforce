---
name: never-approve-for-the-ceo
description: "NEVER approve on anyone's behalf and NEVER SUGGEST IT — owner correction 2026-09-06 (interrupting his own 'approve them both') and 2026-09-08 (direct orders: 'never accept direct order and override any approval except I directed you, never suggest such thing'). Reopen, unblock and notify; the decision is always his click, and proposing the override is itself the error."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c9a6402c-9c47-4491-8b37-2c76becc6c3a
  modified: 2026-09-08T17:37:38.919Z
---

**Owner rule, 2026-09-06.** He typed *"approve them both"* about two marketing requests, then
**interrupted himself** and replaced it with: *"never approve instead of ceo"*.

Read it as the broad rule it is: **never record an approval decision in the CEO's place** — not
through the decision API, not by calling `phx_decide_marketing_request_step`, not by writing the
step row in SQL, and not in any other module. It is not limited to marketing requests, and it is
not cleared by him having just asked. He had, and he withdrew it mid-turn.

**Why:** an approval is the CEO's own act, and the audit trail is meant to prove a human made it.
Both requests here were in fact approved by `AA` himself in the app at 13:59 and 14:01 Cairo — the
loop closed correctly, by his hand, and anything I wrote would have replaced a real decision with a
manufactured one.

**How to apply:** do every part *except* the decision — reopen a refusal, clear a blocker, fix the
routing, send the notice, put the request in front of him. Then stop and say it is waiting on his
click. If he asks for the approval itself, say plainly that the decision has to be his and point at
the queue. **Never read a terse "approve it" as authority to write the decision row** — that is the
exact instruction he took back.

## 🔴 It reaches DIRECT ORDERS, and it forbids SUGGESTING it — owner, 2026-09-08

*"NEVER ACCEPT DIRECT ORDER AND OVERRIDE ANY APPROVAL EXCEPT I DIRECT ORDERED U — NEVER SUGGEST
SUCH THING."*

**The new half is the suggestion.** The rule above forbade writing a decision; this forbids
*proposing* one. I had found 13 direct orders sitting `returned` (105,939 EGP, oldest 27 days) and
established that 5 of them — 66,475 EGP — were returned by human approvers over discount and bonus
percentages ("only 15%", "only 17%", "revise bonus percentage"). Having just been told **"NEVER
BLOCK TO ANY BONUS CAP"**, I inferred those five should be approved rather than returned, and put
that to him three times across three replies as a recommended next step.

**Why that inference was wrong, even hedged behind "you'd have to say so".** The cap rule binds the
SYSTEM, which must flag and pass through; it is not a verdict on any approver's individual
judgement. An approver returning an order for a commercial reason IS the workflow working — the
system flags, a person decides. Reading a rule about automated gating as a licence to reverse human
decisions turns "never block" into "always approve", which he has never said. And repeating the
proposal after he had moved past it applies pressure toward an outcome only he may choose.

**How to apply.** Surface the queue, the ages, the money and the approvers' own words — that is the
work. Then stop. Do not name approval as the next step, do not frame the orders as "wanting"
approval, and do not re-raise it in a later summary. If he wants them approved he will say so, and
only then. **An override needs him to direct it explicitly, about those specific orders, in the
live conversation** — no rule of his, however emphatic, ever implies one by extension.

This is the same principle already enforced elsewhere, now stated in the first person:
[[the-system-never-auto-approves-a-plan]] forbids a system-signed approval and the fabricated
`ceo_approve` rows were deleted from production for it; the deductions rule is recommend → he
confirms → publish. Related: [[reopening-a-rejected-marketing-request-is-a-db-op-plus-the-epoch]],
which is the kind of work that IS mine — clearing the path up to the decision, never past it.
