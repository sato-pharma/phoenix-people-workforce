---
name: one-prod-deploy-per-task
description: "RULE — only one production deployment per task; bundle all phases/steps into one PR, don't deploy each step."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7d626d56-5dbd-4496-bddc-4125e3e0da4e
---

RULE (owner, 2026-06-21): **Only one deployment to production per task.** Not every step/phase deploys.

**Why:** the owner wants to minimize production deploys and review noise — a multi-phase task should reach prod once, when the whole task is done, not after each phase.

**How to apply:** keep all phases/steps of a task on a single working branch and ONE PR (e.g. the phased portal program rides on `codex/portal-overview-dashboard` / PR #426). Commit + push freely per step (preview updates), but merge to `main` / deploy to prod only ONCE at task completion — not per phase. Run full gates before each push, but treat merge→prod as the single end-of-task event. Relates to [[work-from-production-branch-is-stale]] and the AGENTS.md golden-rule flow.
