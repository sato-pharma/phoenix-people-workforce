---
name: subagent-model-tiering-by-task-difficulty
description: "Claude Code has no automatic main-session model switching — the only real lever is picking model/effort per subagent call based on task difficulty, done consistently by the orchestrator."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ef93a92-8c88-4bda-80fc-28de59325dd3
  modified: 2026-07-28T18:07:13.496Z
---

Owner asked (2026-07-28) for a rule to "auto change model based on need." Confirmed via research (claude-code-guide agent, citing code.claude.com docs) that Claude Code has no mechanism — settings, hook, or otherwise — to automatically switch the MAIN session's model mid-conversation based on task complexity. `/model` and the project `model` setting are both static/manual only. Subagent `.md` frontmatter model fields are also static per definition, not runtime-chosen.

**Why:** The owner is heavy-parallel and wants less manual overhead (see [[owner-heavy-parallel-workload-reduce-friction]]) — since there's no platform feature to delegate this to, the closest real substitute is a standing behavioral rule for how I use the tools that DO accept a per-call model/effort override.

**How to apply:**
- When delegating work via the Agent tool or a Workflow's `agent()` calls, choose `model`/`effort` per call based on task difficulty rather than always omitting it (which inherits the session model):
  - Mechanical/cheap lookups (grep-style search, simple file reads, straightforward status checks): lean toward a cheaper/faster model or low effort.
  - Normal implementation, typical code changes, standard research: inherit the session model (omit the param) — this is correct most of the time.
  - Genuinely hard reasoning (security review, architecture tradeoffs, adversarial verification, ambiguous root-cause debugging): use higher effort or the strongest available model.
- Do this by default without being asked each time — that's the actual "auto" part; the platform doesn't do it, I do.
- Don't oversell this to the owner as automatic main-session switching — it isn't; only subagent delegation calls get this treatment.
