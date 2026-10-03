---
name: desktop-slowness-oct-2026-is-thinking-level-and-model-not-memory
description: "Why Claude Code felt 'deadly slow' from 25 Sep 2026 (measured 3 Oct): sessions moved to Extra high on 25 Sep and Max came back 29 Sep-2 Oct (Max = 4-5 min per instruction, slowest quarter 10-13 min); per step Opus 5.5 is fastest (4.3 s) vs Opus 5 6.1 s vs Opus 4.8 10.1 s. NOT memory/rules (26k tokens, smaller than mid-Sep). autoCompactWindow 800000 (raised from 300000 on 26 Sep 01:41 at his compaction complaint) is a secondary cost only. He rejected the window as the cause and was right."
metadata:
  node_type: memory
  type: project
  originSessionId: c736da3e-674b-4f7e-be9d-28431270682f
  modified: 2026-10-03T14:22:07.970Z
---

Measured 2026-10-03 from every transcript in this project folder (17 Sep - 3 Oct) and the
per-turn effort log `~/.claude/relay/usage/*.ndjson` (fields: `t0`/`t` turn start/end ms, `n`
model calls, `m` model, `e` effort, `s` first 8 chars of the session id).

Time per instruction (one turn), median and slowest quarter, since 17 Sep:
- Opus 4.8 High 77 s / 3.4 min · Opus 5.5 Extra high 85 s / 5.9 min · Opus 5 High 109 s / 4.7 min
- Opus 5 Extra high 137 s / 6.3 min · Opus 5 Max 248 s / 10.6 min · Opus 5.5 Max 308 s / 12.6 min (22 steps)

Same history size (150k-300k tokens), 1-3 Oct, per model step: Opus 5.5 4.3 s, Opus 5 6.1 s,
Opus 4.8 10.1 s. Opus 4.8 itself slowed from ~5.5 s (22-24 Sep) to ~10.6 s (3 Oct).

Timeline: 25 Sep Opus 5 sessions began running at Extra high (2,155 calls that day vs ~70/day);
steps slowed the same day at the same history size. Engine 2.1.280 vs 2.1.281 on that same day
were equal, so the engine update is ruled out. 29 Sep - 2 Oct a few Max sessions did the most
work (Opus 5.5 Max ~5,000 calls on each of 1 and 2 Oct).

Not the cause: the rulebook (CLAUDE.md x2 + AGENTS.md + MEMORY.md) is ~103k chars / ~26k tokens
per step, smaller than the ~32k measured on 18 Sep. Main-process freezes in
`%LOCALAPPDATA%\Claude\logs\main*.log` (`[event-loop-stall]`, minus `likely sleep`) total only
~15 s/day. A fresh session starts at ~115k tokens.

Secondary: `autoCompactWindow` in `~/.claude/settings.json` was 300000 until a session raised it
to 800000 at 2026-09-26 01:41 Cairo after he wrote "the frequent session compacting is
frustrating me". Since then median history per step is ~430k (was ~195k); steps at 600k+ take
~8.2 s vs ~4.6 s under 150k. Compactions: 1 per 82 calls before, 1 per 536 after, ~100-120 s each.
He said the window is not the real reason — it is not the main one; do not re-push it.

USAGE (his worry, same day): priced from the relay log at API rates (Opus 5.5 $4/$20, cache
read $0.20; Opus 5 and 4.8 $5/$25, cache read $0.50; cache write taken as 2x input), the 800k
window is the usage drain. Cost per instruction before → after 26 Sep: Opus 5 High $2.53 → $3.45,
Opus 5 Extra high $3.09 → $4.88, Opus 4.8 High $1.81 → $2.44, Opus 5 Max $4.58 → $8.03. Re-reading
history is now 70-82% of every instruction's cost. Max is 2-3x Extra high; High is ~30% under
Extra high; Opus 5.5 costs about the same as Opus 5 at the same level. Switching a running chat's
model forces one full-price re-read, so do not switch open chats to save usage.

🔒 **OWNER DECISION 2026-10-03:** `autoCompactWindow` set to **400000** (from 800000), and new
chats default to **Opus 5 + High**. Never raise the window back to 800k to fix "frequent
compacting" without showing him the usage cost above.
Where the new-chat default lives: the desktop app passes `--model`/`--effort` to every chat
from its picker, so `~/.claude/settings.json` `model`/`effortLevel` do NOT reach desktop chats.
The picker's remembered model (and thinking) is stored on his ACCOUNT (`model_selector_state`,
`selection_source: "user_setting"`), set by choosing it in a new chat's picker — no file can
set it. `%APPDATA%\Claude\claude_desktop_config.json` `preferences.epitaxyPrefs.ccd-effort-level`
is only a local mirror (it read `xhigh` on 3 Oct); do not hand-edit it.

Also seen: a Phoenix "Overview" tab in Firefox used ~0.9 core on its own while idle (the
box-shadow alarm badges, fixed in #5251/#5252).

THE APP'S OWN DRAWING (measured 3 Oct 17:10-17:21, 1-2 s samples of the MSIX claude.exe gpu /
renderer / main processes beside main.log and the transcripts). Corrects an earlier "~1 core all
day": with the window OUT OF VIEW it draws NOTHING (gpu 0%, renderer ~2%, 17:16-17:20) even while
a chat kept working. In view, three costs, biggest first:
- A running chat with a huge history makes the UI renderer spike to 1-3 cores for 1-2 s on its
  steps (Turbify mailbox chat: 30.9 MB, 12,154 entries, running since 24 Sep).
- Bringing a long chat back on screen re-sends its whole history (`[transcript-read] delivered N
  rows` in main.log): Turbify ~3,700 rows each time (17x in 70 min), "Medical reps ranking
  badges" ~2,400 (27x; finished, PR merged, 45.7 MB). Count with the setFocusedSession→delivered
  pairing in main.log.
- `LocalSessions.getPrChecks` polls every PR a chat ever linked (`"type":"pr-link"` entries in the
  transcript) about every 2 min, merged or not: 20 PRs, all merged/closed, 17 of them Turbify's.
A steady ~30% gpu + ~30% renderer also shows while a chat works with the window in view; its
source was not pinned (no way to see his screen). Lever: archive finished long chats and start
long-running work in a fresh chat; never stop or restart the app.

**How to apply:** for a slowness complaint read the effort log and session pickers first; never
re-run this audit from scratch. A session cannot change its own model/effort; it CAN change other
sessions' with `set_session_model`/`set_session_effort`, only on his word. Supersedes the
`autoCompactWindow: 300000` line in [[claude-code-effort-max-got-slow-xhigh-is-the-balance]].
