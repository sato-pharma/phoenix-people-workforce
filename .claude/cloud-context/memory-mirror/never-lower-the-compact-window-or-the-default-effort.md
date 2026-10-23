---
name: never-lower-the-compact-window-or-the-default-effort
description: Keep autoCompactWindow 400000 and effortLevel high in ~/.claude/settings.json; lowering them on 2026-10-23 made compaction 7x more frequent — and the restore reached only sessions launched AFTER it, the running ones kept the small window.
metadata:
  node_type: memory
  type: feedback
  originSessionId: a4522148-cf2e-4572-8b87-ea8d8d1ae801
  modified: 2026-10-23T14:30:40.889Z
---

Keep `autoCompactWindow: 400000` and `effortLevel: "high"` in `~/.claude/settings.json`. Never lower either one as a "performance fix".

**Why:** On 2026-10-23 a performance audit lowered them to 200000 and "medium" (13:13 and 13:58 Cairo).
- Compaction went from 3.1 per hour to 22.7 per hour. One session compacted 34 times in 2.8 hours.
- He said the sessions became "very cold" and "the memory is fading".
- The settings were restored at about 16:05 Cairo the same day.

🔴 **The restore did not reach the sessions already running.** A session's compaction window is fixed when its process starts; a settings change does not reach it. Measured 17:20 Cairo the same day, more than an hour after the restore: the five sessions launched between ~13:13 and 16:00 still compacted at ~167k tokens (the 200,000 window) every 4–6 minutes, with 31, 21, 13, 11 and 6 compactions. Sessions launched after 16:00 compacted at ~370k (the 400,000 window). Each compaction replaces the working memory with an ~8,000-character summary, so these sessions lose detail every few minutes. That is the "acts like the first time" feeling he reported. A settings fix is finished only when every running session has been relaunched (app quit and reopen, or the session stopped and resumed). Read the `preTokens` of `compact_boundary` rows in the transcripts to prove which window a session holds.

Not a cause: on 23 Oct the Code tab's model picker was on `claude-opus-5` from about 07:30 Cairo, so most sessions that day ran on Opus 5, not Opus 5.5. Asked at 17:30 Cairo, he chose "Keep Opus 5": it is his deliberate pick. Never flag it again, and never switch his sessions' model.

"high" is only the default. He picks the model and effort per session (Opus, Fable, extra high, max), and his pick always wins.

**How to apply:**
- To make Claude faster or leaner, never touch these two keys.
- Module memory (`.claude/rules/*.md`) already loads only on demand: it has 59 files, each with `paths:`, and none of it is part of the start-up context.
