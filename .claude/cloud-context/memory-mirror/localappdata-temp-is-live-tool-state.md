---
name: localappdata-temp-is-live-tool-state
description: "Clearing the LOCALAPPDATA Temp folder wholesale deletes the ACTIVE session's own scratchpad and task-output files mid-run, so the next tool read fails with ENOENT - it is live shared state for every concurrent Claude session, never ordinary OS cache to blanket-clear"
metadata: 
  node_type: memory
  type: project
  originSessionId: f780d6cd-755d-4c24-a5b5-ed61d321d53c
---

During a disk-cleanup task (2026-07-11), clearing `$env:LOCALAPPDATA\Temp` (`C:\Users\satoh\AppData\Local\Temp`)
wholesale — treating it like ordinary OS temp cache — deleted the active session's own scratchpad/task-output
files mid-run (`...\claude\<project>\<session-id>\tasks\*.output`), causing a tool-result read to fail with
ENOENT. The machine had **16 other `claude` processes and 6 `node` processes running concurrently** at the time,
confirming this folder is shared live scratch space for multiple simultaneous sessions, not a safe blanket-clear
target.

**Why:** Claude Code (and probably other CLI/agent tools) writes its per-session working files — task output
logs, scratchpad content — under `AppData\Local\Temp\claude\<project>\<session-id>\`. That subtree is
functionally equivalent to a running process's working directory, even though the parent `Temp` folder's name
suggests pure disposability. This is a different hazard class from [[parallel-session-swarm-hazard]] (repo/git
state collisions) — here the collision is over shared OS-level scratch space.

**How to apply:**
- Never bulk-delete `%LOCALAPPDATA%\Temp` (or `$env:TEMP`/`$env:TMP` more generally) on this machine while any
  other Claude Code / agent session might be running — check `Get-Process claude,node` first, and even then treat
  it as high-risk since sessions can start after the check.
- `C:\Windows\Temp` (system-wide, not user-profile) is a materially safer target — it's OS/installer scratch
  space, not observed to be used as live tool working directory.
- Browser caches (`...\Google\Chrome\User Data\Default\Cache`, `...\Microsoft\Edge\...\Cache`), `INetCache`,
  `SoftwareDistribution\Download` (Windows Update), and app-specific installer-leftover folders (e.g.
  `SquirrelTemp`, `Downloaded Installations`) are safe blanket-clear targets — confirmed no issues clearing these
  on the same machine.
- Prefer proper CLI cache-clean commands over raw folder deletion where available: `npm cache clean --force`,
  `pip cache purge`, `go clean -cache`, `pnpm store prune` — these are dependency-aware and won't remove
  anything still referenced.
- If asked to do disk cleanup again on this machine, treat any path containing a running tool's own name
  (`claude`, `codex`, `.cursor`, etc.) as live-data-until-proven-otherwise, not cache-until-proven-otherwise.

Related: [[ai-tool-damage-prevention]], [[parallel-session-swarm-hazard]]
