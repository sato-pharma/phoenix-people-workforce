---
name: ai-provider-pinned-to-anthropic-on-his-word
description: "Since 26 Oct 2026 ~00:00 Cairo production runs AI_PROVIDER=anthropic on BOTH Railway services (owner's pick) — OpenAI is never asked until he says to remove it, even after its key is fixed."
metadata:
  node_type: memory
  type: project
  originSessionId: 6c55ac05-7a8e-4bd0-b489-b353be8a0999
  modified: 2026-10-25T21:00:57.945Z
---

Owner chose "Anthropic first" on 25 Oct 2026 ~23:59 Cairo, after OpenAI had refused its key (401) on every call since 24 Oct 20:48 and every call had already been rescued by Anthropic account 1. Set `AI_PROVIDER=anthropic` on `phoenix-people-workforce` and `phoenix-workforce-worker` (production). The pin keeps both Anthropic accounts in order (key 1 → key 2); Groq speech-to-text is unaffected.

**Why:** he asked why Anthropic was not used instead of OpenAI; he chose the pin over the automatic order.
**How to apply:** a fixed or replaced OpenAI key does NOTHING while this pin is set — remove `AI_PROVIDER` from both services when he says to bring OpenAI back. Never remove it on your own reading. Rule: `.claude/rules/platform.md`, "AI providers".
