---
name: a-missing-suggestion-after-a-resume-is-the-session-being-unloaded
description: "When the owner says the input-box suggestion vanished, first check whether his next message arrived through a SessionStart:resume — if so the session's process was unloaded in between (on 2026-10-02 when free RAM fell to 861 MB) and the suggestion died with it; only otherwise check the >10,000-fresh-token size gate."
metadata:
  node_type: memory
  type: project
  originSessionId: 60e0f2be-a803-444e-bf13-8a9f6b62c24c
  modified: 2026-10-02T17:22:33.523Z
---

On 2026-10-02 the owner reported "suggestions again not appearing". The reply before it was small
(1,911 fresh tokens, well under Claude Code 2.1.284's 10,000 uncached-token skip gate) and every switch
was on (`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` in settings and as a Windows user variable,
`promptSuggestionEnabled: true`). The real cause was in the transcript: the turn ended normally at
20:15:23, and his next message at 20:21:10 arrived through a **`SessionStart:resume`** — the session's
process had been shut down in between. `mem-watchdog.log` showed free RAM falling to **861 MB at 20:19:47**
(Edge jumped to ~5.5 GB) and the Claude process count dropping 25 → 22, with three fresh `claude`
processes starting 20:20–20:21. The watchdog itself killed nothing ("Claude processes spared"), so the
desktop app or Windows unloaded idle sessions under memory pressure. A suggestion lives only in a running
session's input box, so it went with the process.

**Why:** two different causes look identical to him (an empty box), and only one is a suggestion rule.

**How to apply:** read the session JSONL around his message for `SessionStart:resume` before measuring
token sizes. If it is there, the fix is RAM headroom (Edge and open sessions are his windows, his call; the
32 GB upgrade is the hardware fix), not effort or reply length. The size gate is the other cause — see the
2026-10-02 13:08 diagnosis in this note's history and [[claude-code-effort-max-got-slow-xhigh-is-the-balance]].
