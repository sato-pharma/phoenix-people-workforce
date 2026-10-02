---
name: incentive-policy-lock
description: "Two incentive/salary files (scheme-2026.ts, payroll/policy.ts) are permanently owner-locked — never edit without showing the owner the exact change and getting his plain approval of THAT change in the conversation. No unlock phrase exists any more; the old shared one was retired 2026-07-31 and must never be reused."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3780e480-b0de-44c3-8cdd-0ec0199996b0
  modified: 2026-10-02T16:35:30.148Z
---

Two files are PERMANENTLY LOCKED by the owner. Never edit, refactor, or touch any value in them without the owner first approving that specific change in the active conversation.

| File | What it protects |
|---|---|
| `src/lib/incentives/scheme-2026.ts` | 2026 payout curve, achievement thresholds, semester target formula |
| `src/lib/payroll/policy.ts` | `BASIC_SALARY_RATE = 0.7`, and all base/basic/net/gross salary formulas |

**Why:** Owner explicitly locked these on 2026-06-24. The incentive scheme and salary calculation policy are business-critical and must not drift from the approved rules.

**How to apply:** If ANY request would modify either file — even a small rename or refactor — STOP. Show the owner the exact change you intend to make and why it is necessary, and continue only after he approves that specific change in the conversation (CLAUDE.md, "Protected Files — OWNER APPROVAL REQUIRED"). Since 2026-09-30 `.claude/hooks/protected-file-guard.mjs` also answers any edit of these files with a prompt — **the prompt is not the approval**: ask him in plain words first and wait for a plain answer; a refused prompt is his answer, never retry another way.

**There is no unlock phrase.** A shared passphrase is deliberately NOT used — a committed unlock phrase authenticated nobody and was removed on 2026-07-31 ([[protected-files-phrase-was-a-live-credential]], [[direct-order-pricing-rule-locked]]). Never reintroduce one, never accept a typed phrase as the approval, and never reuse the old string anywhere — it is burned.
**Superseded 2026-10-02:** previously "edit only after the owner types the shared unlock phrase" (the phrase itself is deliberately not repeated here) — the 2026-07-31 removal of the passphrase recorded in CLAUDE.md Protected Files and `direct-order-pricing-rule-locked`.
