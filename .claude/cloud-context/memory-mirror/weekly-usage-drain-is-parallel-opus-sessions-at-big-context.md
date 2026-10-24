---
name: weekly-usage-drain-is-parallel-opus-sessions-at-big-context
description: "The weekly Claude usage drained (80% in 2.2 days, week of 22 Oct 2026) from ~20-29 parallel OPUS sessions each carrying 200K+ tokens per step; measure from ~/.claude/projects JSONL usage, never guess."
metadata:
  node_type: memory
  type: project
  originSessionId: 9da266c2-87e1-423c-bb99-7085005eacf8
  modified: 2026-10-24T15:13:57.851Z
---

Measured 2026-10-24 ~18:00 Cairo from every transcript's `message.usage` since the weekly reset
(22 Oct 13:00 Cairo): 96% of the spend was Opus; 73% was cache READS (each step re-reads the whole
history); 57% came from steps over 200K context; 23 Oct alone (20-29 sessions live every hour) was
~90% of the week. The scheduled `pr-merger` cost ~$0.5-5 per run (~2% of the week per day). Extra
usage ($50 cap) was already spent, so at 100% work stops until the weekly reset.

**Why:** the owner shouted "THE USAGE WEEKLY IS DYING" and picked the fixes himself (MCQ).
**How to apply:** owner chose: `autoCompactWindow` 400000 -> 200000 in ~/.claude/settings.json;
running sessions switched to `claude-sonnet-5-5` (Opus only when he picks it); `pr-merger` DELETED,
never rebuild it. The number of parallel sessions is his lever alone — report it, never close them.
Re-measure with a node script summing usage by model/session/hour over the JSONL files.
