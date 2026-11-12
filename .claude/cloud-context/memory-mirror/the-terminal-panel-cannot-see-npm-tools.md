---
name: the-terminal-panel-cannot-see-npm-tools
description: "The desktop app's Terminal panel sees its OWN copy of AppData — C:\\Users\\satoh\\AppData\\Roaming\\npm does not exist there, so `railway` (and every npm-global tool) is 'not recognized'; gh, node (Program Files), ~/.railway and the scratchpad ARE visible"
metadata:
  node_type: memory
  type: reference
  originSessionId: 8d69d082-3260-4564-9f47-4a72441125cd
  modified: 2026-11-12T19:52:47.332Z
---

Measured 12 Nov 2026: in a Terminal-panel tab (same user, `omar-gawish\satoh`), `Test-Path
'C:\Users\satoh\AppData\Roaming\npm'` is **False**, while the Bash and PowerShell tools see the folder and
`railway.cmd` in it. So a script handed to the owner to run in the panel fails at `railway` with "The term
'railway' is not recognized" — after the steps before it (`.env.local`, `gh secret set`) already ran.

Visible from the panel: `C:\Program Files\nodejs\node.exe`, `gh`, `C:\Users\satoh\.railway\config.json` (the
Railway sign-in) and the session scratchpad under `AppData\Local\Temp\claude\...`.

**How to apply:** for an owner-run script that needs Railway, copy the real binary
(`AppData\Roaming\npm\node_modules\@railway\cli\bin\railway.exe`) into the scratchpad and call it by full
path; check it first from the panel with `& '<path>\railway.exe' status` (prints no variables). Never use the
GitHub→Railway secrets sync to move one key — it rewrites ~60 production variables and covers the web service
only. Context: [[healthchecks-moved-to-a-new-free-account-2026-11-12]].
