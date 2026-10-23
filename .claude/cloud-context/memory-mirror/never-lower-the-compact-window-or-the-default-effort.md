---
name: never-lower-the-compact-window-or-the-default-effort
description: Keep autoCompactWindow 400000 and effortLevel high in ~/.claude/settings.json; lowering them on 2026-10-23 made compaction 7x more frequent and he reverted it.
metadata:
  node_type: memory
  type: feedback
  originSessionId: a4522148-cf2e-4572-8b87-ea8d8d1ae801
  modified: 2026-10-23T13:01:42.544Z
---

Keep `autoCompactWindow: 400000` and `effortLevel: "high"` in `~/.claude/settings.json`. Never lower either one as a "performance fix".

**Why:** On 2026-10-23 a performance audit lowered them to 200000 and "medium" (13:13 and 13:58 Cairo).
- Compaction went from 3.1 per hour to 22.7 per hour. One session compacted 34 times in 2.8 hours.
- He said the sessions became "very cold" and "the memory is fading".
- The settings were restored at about 16:05 Cairo the same day.

"high" is only the default. He picks the model and effort per session (Opus, Fable, extra high, max), and his pick always wins.

**How to apply:**
- To make Claude faster or leaner, never touch these two keys.
- Module memory (`.claude/rules/*.md`) already loads only on demand: it has 59 files, each with `paths:`, and none of it is part of the start-up context.
