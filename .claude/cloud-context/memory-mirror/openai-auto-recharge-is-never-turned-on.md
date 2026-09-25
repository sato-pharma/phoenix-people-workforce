---
name: openai-auto-recharge-is-never-turned-on
description: "OWNER RULE 2026-09-18 — he will NEVER turn on OpenAI auto-recharge; never suggest it. Out of credit is handled by the Telegram alert (PR #3994), then a manual top-up."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bc76d00a-bf32-4bf1-968b-b08e88271c9d
  modified: 2026-09-18T08:02:49.534Z
---

The owner will never enable auto-recharge on the OpenAI account (his words, 2026-09-18: "I WILL NEVER TURN ON OPEN AI AUTO CHARGE"). Never suggest it, never list it as an option or a "next step", never re-raise it after an out-of-credit outage.

**Why:** his decision on spending control — the balance is topped up by hand, on purpose.

**How to apply:** when OpenAI answers `insufficient_quota` (every AI feature fails at once), the design is: `src/lib/notifications/ai-quota-alert.ts` pages him in-app + Telegram once per Cairo day, and he tops up manually. Report the outage and point at the top-up; do not propose automating the payment. Related: the 2026-09-18 incident — key rejected 23:30–03:44 (key replaced ~03:45), then out of credit ~09:55 and topped up before 10:50.
