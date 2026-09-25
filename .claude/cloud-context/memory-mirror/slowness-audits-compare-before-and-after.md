---
name: slowness-audits-compare-before-and-after
description: "When the owner says something \"worked until N days ago\", find what CHANGED with a dated before/after comparison from transcripts and settings backups; a snapshot of current load is what he rejected as \"the easy way\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2b696c6d-5f20-43da-a94a-30fe4bbdac5b
  modified: 2026-09-17T15:53:51.646Z
---

On 2026-09-17 he asked why Claude Code desktop was very slow. The first answer ranked current memory pressure, window CPU and session count. He rejected it: he had run heavier work and more sessions before, it "was working very well until about two or three days before", and he wanted the real cause, not "the easy way".

**Why:** a snapshot shows what is heavy now, not what changed. The real cause only appeared in a per-day comparison of transcripts against the settings backups: sessions went back on max effort after a cap was removed (see [[claude-code-effort-max-got-slow-xhigh-is-the-balance]]).

**How to apply:** for any "it got slow" or "it broke recently" report, date the change first. Sources:
- Per-day metrics from `~/.claude/projects/*/*.jsonl`: reply time, steps per reply, effort and build version.
- The `~/.claude/settings.json.bak-*` history.
- Same-day comparisons that differ in only one thing.

Rank causes by what changed, not by what is biggest.
