---
name: effort-multiplier-is-the-biggest-usage-lever
description: "Claude Code's own effort_cost_index — Sonnet at max costs 5.59x its default, Opus 5 at max costs 1.91x — and the fact that no hook can change effort, only /effort or the app picker."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9680c8dc-ecf5-4c20-a573-acb18754d37e
  modified: 2026-08-13T15:56:14.851Z
---

Read directly out of Claude Code 2.1.227's binary on 2026-08-13 (`effort_cost_index`), normalised
so each model's own default effort (`high`) = 1.00:

| model | low | medium | high (default) | xhigh | max |
| --- | --- | --- | --- | --- | --- |
| claude-opus-5 | 0.60 | 0.77 | 1.00 | 1.74 | **1.91** |
| claude-opus-4-8 | 0.67 | 0.76 | 1.00 | 1.60 | 1.70 |
| claude-opus-4-7 | 0.72 | 0.90 | 1.00 | 1.65 | 1.88 |
| claude-sonnet-5 | 0.47 | 0.74 | 1.00 | 2.41 | **5.59** |
| claude-sonnet-4-6 | 0.47 | 0.74 | 1.00 | 2.41 | 5.59 |

**Sonnet at `max` costs 5.59x its own default** — a near-6x multiplier on the model chosen for
being cheap. Never leave Sonnet above `high`.

Every session on this machine was launching with `--effort max` (verified from live process
command lines 2026-08-13), one on `claude-opus-5` and one on `claude-sonnet-5`. That is the
single biggest reason two Max accounts get consumed. See
[[switching-max-accounts-never-loses-the-transcript]].

**Why:** effort is invisible — set at launch, never displayed — so it can sit at `max` for weeks
while the raw token counts look unremarkable.

**How to apply:**

- **No hook can set effort.** Session-lifecycle hooks are not even given the current level; it is
  handed only to hooks firing inside a tool-use context (PreToolUse/PostToolUse/Stop/SubagentStop).
  Never claim to have automated it for the main session.
- `/effort <low|medium|high|xhigh|max>` changes it mid-session from an interactive terminal.
- `effortLevel` **is** a real `settings.json` key, but the desktop app passes `--effort` explicitly
  on every launch and **a CLI flag overrides settings** — so editing settings will not change
  app-launched sessions. The app's effort picker is the real control.
- Subagents DO carry model+effort automatically via `.claude/agents/*.md` frontmatter — that is the
  only genuinely automatic routing available. See
  [[relay-carries-work-and-limits-between-accounts]].
- Do not cheapen payroll, migration, RLS or production work to save effort cost. The router
  deliberately stays silent there.
