---
name: powershell-get-process-silently-empty-cross-session
description: "A filtered Get-Process pipeline (StartTime + Sort-Object) can return silently empty for processes outside the tool's own session — cross-check with Get-CimInstance Win32_Process before concluding a PID is dead"
metadata: 
  node_type: memory
  type: project
  originSessionId: cc309d00-6b69-4b14-9df8-cfd6d5d905c6
  modified: 2026-08-09T23:46:58.795Z
---

Verified 2026-08-10: `Get-Process -Id <pid>` and
`Get-Process | Where-Object {ProcessName -match 'node|claude'} | Select-Object Id,ProcessName,StartTime,CPU | Sort-Object StartTime`
returned completely empty output (no rows, no error) in this sandboxed PowerShell tool — for a PID
belonging to another live Claude Code session, and for a broad `node|claude` name filter — even
though `Get-Process | Measure-Object` in the same call returned 402 total processes visible, and
`Get-CimInstance Win32_Process -Filter "Name='claude.exe' or Name='node.exe'"` found 25 matching
processes at essentially the same moment.

**Why:** `.StartTime` needs more access (`PROCESS_QUERY_INFORMATION`) than basic enumeration
(`PROCESS_QUERY_LIMITED_INFORMATION`). Objects that all throw on that property access, piped into
`Sort-Object`, can silently drop the whole pipeline's output in this environment instead of emitting
a per-item error — so a live cross-session/cross-user PID looks identical to a genuinely-absent one.

**How to apply:** never conclude "process not found" from one filtered
`Get-Process | Select StartTime | Sort-Object` pipeline. Cross-check with
`Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` (or drop `StartTime`/`Sort-Object` from the
Get-Process call) before treating a session lock as stale or a PID as dead. `Get-CimInstance
Win32_OperatingSystem` for free-RAM figures was unaffected either way. Related:
[[cannot-map-claude-sessions-to-worktrees]].
