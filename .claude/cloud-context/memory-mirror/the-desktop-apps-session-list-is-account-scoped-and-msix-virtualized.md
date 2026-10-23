---
name: the-desktop-apps-session-list-is-account-scoped-and-msix-virtualized
description: "The Code sidebar lists ONE account's sessions (<account>/<org>/local_*.json) while the conversations are shared by every account — and that store is MSIX-virtualized, so a scheduled task cannot see the path a session sees."
metadata:
  node_type: memory
  type: reference
  originSessionId: 896a9c28-5d3e-4111-a2d1-4fe0a680f223
  modified: 2026-10-23T00:46:17.202Z
---

The desktop app's session list is **per account**: `%APPDATA%\Claude\claude-code-sessions\<accountUuid>\<organizationUuid>\local_<id>.json`, one small record per session. The **conversation** is not account-scoped at all — it is `~/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl`, shared by every account on the machine. So a session left unfinished on one account is sitting on this disk fully resumable and simply not listed under the other; copying its record into the signed-in account's folder lists it and it opens on the same conversation. The accounts are named in `~/.claude/relay/accounts.json` (Omar — oagaweesh@gmail.com `87292b52…`, Gawish — phoenixx.oag@gmail.com `9b516841…`, plus old free ones whose `.jsonl` files have aged out, so their records would open empty).

🔴 **MOVED ~22 Oct 2026: the store is now `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude-code-sessions\<account>\<org>\`** — neither path below exists any more, and the hourly import failed every run until `storeCandidates` learned it on 23 Oct 03:40 Cairo. A window close only hides the app to the tray: the process (start time is the proof) keeps running and the imported records stay invisible until a real Quit.

🔴 **The running app holds that list in MEMORY and never re-reads the folder** — a record copied in while it runs is invisible to the sidebar, to `mcp__ccd_session_mgmt__list_sessions` and to `get_session` ("not found"), and appears at the app's next start. Never report an import as visible without checking which of the two you measured.

🔴 **And that folder is MSIX-VIRTUALIZED, each view hiding the other with no error.** The app is the package `Claude_pzs8sxrjxfjjc`, so a process **inside** its container — any Claude Code session, which the app starts — sees the store at `%APPDATA%\Claude\…`, while a process **outside** it — a scheduled task, a plain terminal — sees that same path as *not existing* and finds the store under `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\…`. `Test-Path` answers plain `False` and `fs.existsSync` answers `false`, so a script that hard-codes one spelling works perfectly in a session and reports "no session folder yet" from an hourly task. `~/.claude` itself is NOT redirected (it is outside AppData) — only the app's own AppData. Resolve by trying both roots: `~/.claude/scripts/import-account-sessions.mjs` (`storeCandidates`) does.

Also measured the same evening: `conhost.exe --headless <exe> <args>` **silently does nothing** when launched from the MSYS Bash tool here — exit 0, command never runs — although the same spelling works from Task Scheduler. Diagnose a scheduled task by redirecting the child's streams to files via `Start-Process`, never by trusting conhost's exit code. See [[two-session-stores-two-retention-keys]].
