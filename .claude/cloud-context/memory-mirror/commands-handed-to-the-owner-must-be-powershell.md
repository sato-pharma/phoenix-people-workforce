---
name: commands-handed-to-the-owner-must-be-powershell
description: "A command written for the owner to paste must be PowerShell 5.1 - his Terminal tab rejects bash `&&` with a parser error before anything runs, and a bash-tagged fence gives him a Run button that routes back through Claude"
metadata:
  node_type: memory
  type: feedback
  originSessionId: e94a655d-2c8b-49f4-9c2c-ad15fddfe252
  modified: 2026-09-27T17:14:37.426Z
---

**Any command handed to the owner to run himself must be Windows PowerShell 5.1, not bash.** His
Terminal tab beside the conversation is `powershell.exe`, where `&&` is not a statement separator:
the whole line dies on `The token '&&' is not a valid statement separator in this version` before a
single character of it executes. Use two lines, or `;`.

**Why:** on 2026-09-27 a cron-registration handover was written as
`cd "F:\…" && railway run -- node scripts/cronjob-sync.mjs …`. He pasted it twice and it failed
identically both times. Nothing was created and no API budget was spent, but it cost two round trips
and both failures looked like his mistake when they were the instruction's. Claude's own Bash tool
is Git Bash, so `&&` works there and the habit carries over invisibly.

**How to apply:**
- Two separate lines, never `&&`. The working directory persists between his pastes, so one `cd`
  first and the rest bare.
- Read [[the terminal]] with `mcp__terminal__read_terminal` before assuming he did not run it - a
  parser error looks like silence.
- Use a **plain, untagged** code fence for anything he must run with his own hands. A ```bash fence
  renders a Run button that routes the command back through Claude's own Bash tool, which is the
  wrong shell and, when the command was refused for Claude, walks straight back into the refusal.
- This is separate from Claude's own shell choice; see [[tz-africa-cairo-silently-returns-utc-in-msys]]
  for the other direction, where the MSYS shell misleads Claude rather than him.
