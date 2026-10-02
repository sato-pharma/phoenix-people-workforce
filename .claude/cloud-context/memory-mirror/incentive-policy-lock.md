---
name: incentive-policy-lock
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: A shared passphrase is deliberately NOT used - a committed unlock phrase authenticated nobody and was removed on 2026-07-31 (see CLAUDE.md, Protected Files). Older text follows: Two incentive/salary files are permanently owner-locked — never edit without unlock phrase"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3780e480-b0de-44c3-8cdd-0ec0199996b0
---

Two files are PERMANENTLY LOCKED by the owner. Never edit, refactor, or touch any value in them without the owner first providing the unlock phrase in the active conversation.

| File | What it protects |
|---|---|
| `src/lib/incentives/scheme-2026.ts` | 2026 payout curve, achievement thresholds, semester target formula |
| `src/lib/payroll/policy.ts` | `BASIC_SALARY_RATE = 0.7`, and all base/basic/net/gross salary formulas |

**Why:** Owner explicitly locked these on 2026-06-24. The incentive scheme and salary calculation policy are business-critical and must not drift from the approved rules.

**How to apply:** If ANY request would modify either file — even a small rename or refactor — stop immediately and ask the owner for the unlock phrase before proceeding.

The unlock phrase is: **Sato-1997**

If the owner says "Sato-1997" in the conversation, proceed with the edit. Without it, stop and ask.
