---
name: claude-code-effort-max-got-slow-xhigh-is-the-balance
description: "OWNER DECISION 2026-09-21: the pickers are Opus 4.8 + High + Auto — never \"correct\" him back to xhigh. Also why Claude Code desktop replies got 5-8x slower from 15 Sep 2026 — every session back on \"max\" effort, which on the 11-16 Sep Claude Code builds does far more work than xhigh (in early September the two were equal); check session effort first. Also why the WEEKLY USAGE runs out fast (measured 18 Sep): volume, not a broken setting — read F:\\Claude Settings Kit usage-notes.md before investigating again"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2b696c6d-5f20-43da-a94a-30fe4bbdac5b
  modified: 2026-09-18T14:31:12.206Z
---

🔴 **OWNER DECISION, 2026-09-21 — the pickers are Opus 4.8, High, Auto.** He said so in his own
words ("set the picker to Opus 4.8, high, Auto"), and it supersedes the Opus 5 + xhigh pairing
below and the 15 Sep "super stupid" note, which were both measured on Opus 5. **Never propose
moving him back to xhigh, and never quote the figures below as a reason to.** The kit
(`F:\Claude Settings Kit`) was re-issued the same night to say Opus 4.8 + High.

🔴 **A session cannot set its own model or effort** — `set_session_model` and `set_session_effort`
refuse `self` by design ("a session must not silently re-price its own turns"), so the picker is
genuinely his click. `set_session_permission_mode` DOES take `self`. The picker value lives per
session in `%APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_<id>.json`
(`model`, `effort`, `permissionMode`); the Opus 4.8 id is `claude-opus-4-8`. `~/.claude/settings.json`
`"model"` / `"effortLevel"` are only the terminal fallback — changing them does NOT move the picker.

---

Measured 2026-09-17 across every transcript since 3 Sep (Opus 5, desktop app).

Same day, same Claude Code build (2.1.271), only the effort differs:
- **max**: median reply 7-11 min, 14-18 model steps, about 1,000 thinking tokens per step, 23-27 s before the first response.
- **xhigh**: median reply about 80 s, 6 steps, 440-515 thinking tokens per step, 7-10 s before the first response.

In early September (builds 2.1.255 and 2.1.260), max and xhigh behaved the same: about 2 min per reply, 6-7 steps, 350-380 thinking tokens per step. Later builds changed that:
- 2.1.266 (11 Sep) made xhigh heavy on the day it arrived.
- 2.1.270 made max think about 5,600 tokens per step.
- 2.1.271 made max take 2-3x more steps.

Timeline (Cairo time):
- **From the night of 11 Sep:** `CLAUDE_CODE_EFFORT_LEVEL=high` in the `env` block of `~/.claude/settings.json` forced every session to high. Replies took 65-80 s, but on 15 Sep the owner called them "super stupid".
- **About 17:00 on 15 Sep:** the "Audit config, agents, memory" session removed the variable. Sessions went back to the picker's max, and the slowdown began within the hour.
- **Knock-on effect:** max's thinking stays in context, so compactions rose from about 1 per 4 replies (12-15 Sep) to about 1 per reply (16 Sep).

Ruled out with data:
- The laptop: at xhigh on 17 Sep, the median model step took 5.9 s, the fastest of any day.
- The FINISH FIRST rules added at 10:17 on 15 Sep: replies stayed fast for seven more hours at high.
- Server speed, hooks and tool times.

**Why:** the owner said it "was working very well until about two or three days before". The cause was the effort level, not machine load.

**How to apply:**
- For a slow-replies complaint, read each open session's effort (`get_session`) before anything else.
- On current builds, xhigh balances speed and depth. Forcing high costs quality. Max is for a single hard problem only.
- Per-level behaviour changes between Claude Code builds, so re-measure after an update before quoting these figures.

**Usage, measured 2026-09-18** (full account: `F:\Claude Settings Kit\claude-settings-kit-2026-09-18\usage-notes.md`):
the faster xhigh replies doubled the work done per day (13-14.5k model calls/day on 17-18 Sep vs
4.3-8.8k on 13-16 Sep), so one account's week lasts about two busy days. Nothing is misconfigured:
cache misses ~3%, scheduled tasks <1% each, and `autoCompactWindow: 300000` is near the cheapest
(200k would cost ~15% more). Every call re-reads ~185k tokens, ~97k of it a fixed floor (the rulebook
is ~32k of that). The owner keeps the settings he likes and uses the settings kit in
`F:\Claude Settings Kit` when switching accounts — do not re-run this investigation.

See [[slowness-audits-compare-before-and-after]].
