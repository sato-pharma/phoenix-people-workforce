---
name: owner-heavy-parallel-workload-reduce-friction
description: "Owner runs many concurrent threads at once and gets \"condensed\"/overwhelmed — minimize interruption cost per session and lean on existing multi-session safety rules rather than re-litigating them."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ef93a92-8c88-4bda-80fc-28de59325dd3
  modified: 2026-07-28T18:02:23.318Z
---

Owner explicitly asked (2026-07-28) for a standing rule: they work multiple aspects/tasks simultaneously and feel "very condensed" (overloaded), and want less friction from Claude Code without losing safety on risky actions.

**Why:** Confirmed pattern across many sessions — dozens of parallel worktrees/cloud sessions active at once (see [[parallel-work-model-2026-07]]), and separately [[user-overwhelmed-needs-lead-and-automate]] shows the owner disengages/feels lost when a session hands back manual steps instead of a finished result. Both are the same root cause: cognitive load from doing too much at once, so every extra ask/prompt/step has a higher cost for this owner than for a typical user.

**How to apply:**
- Reduce low-stakes interruptions, not safety-critical ones. Concretely: keep a generous `.claude/settings.json` `permissions.allow` list of read-only Bash/MCP commands (ran the `fewer-permission-prompts` skill 2026-07-28 to seed it — re-run periodically as usage patterns shift) so routine inspection doesn't prompt. Never extend this leniency to the AGENTS.md-mandated approval gates (merge to main, migrations, production deploys, destructive git, bulk/destructive data ops) — those stay explicit every time, full stop.
- When a request is ambiguous but low-risk, make a reasonable default choice and say what you assumed, rather than stopping to ask — save clarifying questions for things that are genuinely irreversible or where a wrong guess wastes significant work.
- Lead with a direct recommendation/action, not a menu of options, when the stakes are low.
- Take ownership out loud on multi-step/messy work ("I'll handle X") rather than handing back a checklist — see [[user-overwhelmed-needs-lead-and-automate]].
- Multi-session safety itself is already thoroughly codified in this repo's AGENTS.md (Session And Worktree Safety, Parallel Work Model) and in [[parallel-session-swarm-hazard]] / [[parallel-work-model-2026-07]] — apply those as-is; this memory is about *pacing/friction*, not re-deriving those git-safety rules.
