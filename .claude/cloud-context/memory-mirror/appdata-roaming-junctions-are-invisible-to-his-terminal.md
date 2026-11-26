---
name: appdata-roaming-junctions-are-invisible-to-his-terminal
description: "His own PowerShell cannot see any AppData\\Roaming junction from the 12 Nov offload — a global npm CLI must be called at D:\\C-Offload\\Roaming\\npm, never the C: spelling."
metadata:
  node_type: memory
  type: project
  originSessionId: 8d9ef456-7d5b-448c-bbe6-0191201d52c5
  modified: 2026-11-26T10:41:55.231Z
---

On 12 Nov 2026 ~08:41 Cairo most of `C:\Users\satoh\AppData\Roaming` was offloaded to
`D:\C-Offload\Roaming` with real Windows junctions (npm, Telegram Desktop, Thunderbird, Zoom).
**A Claude session's own Bash follows those junctions; the terminal process the app gives HIM does
not — `Test-Path 'C:\Users\satoh\AppData\Roaming\npm'` answers `False` there while
`cmd /c dir /a` shows `<JUNCTION> npm [D:\C-Offload\Roaming\npm]`, and the Telegram junction is
invisible to it too.** So every globally installed npm CLI — railway, claude, clasp, cf-wrangler,
49 entries — is unreachable from his shell by the `%APPDATA%\npm` spelling, and a command that
works when Claude runs it fails for him with `CommandNotFoundException` naming a path that exists.

**Why:** it cost three failed hand-offs on 26 Nov 2026 (the `railway run … --apply` commands for the
rep-tablet locks), each diagnosed as a PATH gap and then as a bash symlink. Neither was true: the
junction is real and the folder is there. His process simply has a different view of
`AppData\Roaming`.

**How to apply:** a command handed to him never spells a path through `AppData\Roaming` — use
`D:\C-Offload\Roaming\npm\…` (for Railway, `D:\C-Offload\Roaming\npm\node_modules\@railway\cli\bin\railway.exe`).
`D:\C-Offload\Roaming\npm` was added to his **user PATH** on 26 Nov 2026 12:5x Cairo, and a fresh tab
answers `railway --version` → `railway 5.59.0`, so bare `railway` works in any NEW window; the old
`C:\Users\satoh\AppData\Roaming\npm` entry was left in place. Prove a handed command by running it
in HIS shell (`mcp__terminal__run_in_terminal`), not only in Bash — that is the only place the
difference shows. See [[commands-handed-to-the-owner-must-be-powershell]].
