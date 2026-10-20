---
name: a-stale-chrome-native-host-squats-the-bridge-pipe
description: "Claude in Chrome says connected but no session can reach it - an orphaned chrome-native-host.exe holds the named pipe and every new host dies on EADDRINUSE; find the owner with GetNamedPipeServerProcessId, never by guessing."
metadata:
  node_type: memory
  type: reference
  originSessionId: 9eec3cb9-758d-4faf-b673-80ea2e5683e5
  modified: 2026-10-19T19:11:42.169Z
---

**Claude in Chrome / Edge reports itself connected, the extension's own side-panel chat works,
and yet every `mcp__claude-in-chrome__*` call in a Claude Code session answers "not connected"
and `list_connected_browsers` returns `[]`.**

The bridge is a single Windows named pipe per user: `\\.\pipe\claude-mcp-browser-bridge-<user>`.
The browser launches `chrome-native-host.exe`, which **listens** on it. An orphaned host from an
earlier day keeps the pipe, so every new host — from either browser, and from both the npm CLI and
the app-bundled CLI — dies instantly with `EADDRINUSE` and the extension never attaches.
Measured 19 Oct 2026: the squatter had been running since **18 Oct 18:19**, over 27 hours.

**Why:** nothing reaps the host when the browser or extension connection goes away, and the error
is invisible — the browser swallows the host's stderr, so the extension only reports "not connected".

**How to apply:**

1. Run the launcher by hand to see the real error — it is otherwise never shown:
   `"" | & "$env:USERPROFILE\.claude\chrome\chrome-native-host.bat"` → look for `EADDRINUSE`.
2. **Find the owner exactly, never by guessing.** Connect a client to the pipe and call
   `GetNamedPipeServerProcessId` (kernel32, P/Invoke from PowerShell). Three guesses were wrong
   first — the `claude --chrome` terminal session, a bare npm `claude.exe`, and the desktop app
   were all innocent.
3. `Stop-Process -Id <that pid> -Force`, confirm with
   `[System.IO.Directory]::GetFiles("\\.\pipe\") | ? { $_ -like '*claude-mcp-browser-bridge*' }`.
4. The extension does **not** respawn the host on its own — the owner must re-connect it in the
   Claude side panel, or restart the browser.

**Three things that look like the cause and are not:**

- **The Claude account.** The extension can be signed in to the right account and still never attach.
- **Chrome vs Edge.** Both register the same host manifest under
  `HKCU:\Software\{Google\Chrome,Microsoft\Edge}\NativeMessagingHosts\com.anthropic.claude_code_browser_extension`.
  Switching browsers changes nothing.
- **Restarting the Claude desktop app.** The app exposes no Claude-in-Chrome setting at all and
  does not hold the pipe. A restart costs every live session and fixes nothing.

`~/.claude/bridge-spawn` staying empty is a **symptom**, not a cause: the host writes there only
after it binds. Related: [[the-turn-box-took-the-ghost-text]], [[claude-code-effort-max-got-slow-xhigh-is-the-balance]].
