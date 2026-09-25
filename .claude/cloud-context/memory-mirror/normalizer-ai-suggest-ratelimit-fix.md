---
name: normalizer-ai-suggest-ratelimit-fix
description: "/sales/normalizer \"AI is rate-limited\" 429 root cause + fix (PR 723, not merged when written): oversized gpt-4o requests (800 alias rows plus the depth multiplier from PRs 639 and 702) exceed the per-minute token limit; OpenAI also answers 429 for insufficient_quota, so check billing first."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b3742f6-32c3-4a21-ac9d-1d563a87daa2
---

The `/sales/normalizer` → AI suggest error **"AI is rate-limited right now — wait a moment and click AI suggest again."** is NOT transient. Root cause = oversized OpenAI request: `src/lib/sales/normalizer/ai-suggest.ts` pastes the full brick list (439) + up to **800** historical alias rows (long Arabic name+address) into EVERY 60-item batch on heavyweight **gpt-4o** (~45k tokens/call); PR #702's Standard/Double/Triple depth let one press fire up to **15 calls back-to-back** → blows past OpenAI's per-minute **token** limit (Tier-1 gpt-4o = 30k TPM). Both culprits shipped the same week: #639 (learn-from-ALL-history huge context) + #702 (depth multiplier).

Reporting bug: OpenAI returns 429 for BOTH a rate-limit AND `insufficient_quota` (out of credit / billing not set up); the code showed "wait a moment" for both, so a billing problem looked transient. **When this recurs, check the OpenAI billing/credit dashboard FIRST.**

Fix = PR #723 (branch `codex/normalizer-ai-suggest-ratelimit`, worktree `F:/Phoenix Workforce/_wt-normalizer-ai-fix`): (1) revert #702 depth back to fixed 300/cat, (2) cap reference aliases 800→120 via env `AI_SUGGEST_MAX_REFERENCE_ALIASES`, (3) honest billing-vs-ratelimit 429 messages. typecheck+lint green. **NOT merged.**

**Why:** the rate limit was self-inflicted by the week's own features, and the misleading error hid a possible billing cause.
**How to apply:** if 429s persist after #723 → either low OpenAI tier (add 429 retry/backoff or switch this task to gpt-4o-mini) or real `insufficient_quota` (top up). A parallel session (host Omar-Gawish) had uncommitted retry/backoff WIP + edits to the SAME `route.ts`/`normalizer-workspace.tsx`; #723's revert WILL conflict — reconcile before merge. See [[parallel-session-swarm-hazard]] [[one-prod-deploy-per-task]].
