---
name: attendance-agent-device-unreachable-and-token-rotation-pending-restart
description: "RESOLVED / HISTORICAL (closed 2026-09-21) - the 2026-07-30 attendance outage and the ATTENDANCE_AGENT_TOKEN rotation that was pending an agent restart are both long finished; its Cloud Run and Secret Manager steps are dead-platform. Keep only for the /health checks reading procedure. Do NOT tell the owner a token restart is outstanding."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2701071e-097f-4d4e-889e-9ca1be40a17f
  modified: 2026-09-20T23:34:36.876Z
---

🔴 **RESOLVED / HISTORICAL — closed 2026-09-21. Do not act on anything below as an open item.**

- **The token rotation is finished.** Proof, not inference: on 2026-09-20 the 14:00, 16:00 and 17:00
  syncs all logged `Scheduled sync completed` and **inserted 30, 1 and 2 rows** into production. A
  sync cannot insert a punch without authenticating to Phoenix with `ATTENDANCE_AGENT_TOKEN`, so the
  running agent holds a working token. **Never tell the owner an agent restart is outstanding.**
  (The unkillable PID 16812 below also died with the 2026-08-26 Windows reinstall.)
- **The 2026-07-30 outage is long over** and its "down since" framing is superseded.
- ☠️ **Its Cloud Run and Secret Manager steps are DEAD PLATFORM** — `AGENTS.md` §3: GCP and Vercel are
  dead, never deploy to or verify against them. Production is Railway.
- **Still useful, and the only reason this file is kept:** the `GET http://127.0.0.1:8787/health`
  reading procedure, and the warning that `invoke-sync.ps1`'s `Ensure-Agent` treats any non-200 as
  "not running" and spawns another instance.

Current behaviour and the owner's standing ruling live in
[[attendance-agent-crashes-at-logon-but-loses-no-attendance]] and
[[attendance-agent-needs-the-office-lan]].

---

The attendance agent runs on the **owner's own laptop** (confirmed 2026-08-01), not a separate
server. Two independent things are true right now.

## 1. Attendance sync has been down since 2026-07-30 — device unreachable, NOT a token problem

`GET http://127.0.0.1:8787/health` returns **503** with:
```
{"status":"degraded","checks":{"tokenConfigured":true,"sdkRegistered":true,
 "deviceTcpReachable":false,"deviceConnects":false,"phoenixReachable":true,
 "errors":["Device 192.168.100.52:4370 is not reachable."]}}
```
Token, SDK and Phoenix connectivity are all **fine** — only the ZKTeco device is unreachable.
`192.168.100.x` is an office-LAN address and this is a laptop, so **the most likely cause is simply
being off the office network**, not a fault. Punches queue on the device itself and sync on
reconnect, so nothing is lost — but a long enough gap eventually fills the device's storage.

Evidence of duration: `local-attendance-agent/logs/scheduled-sync.log` shows the last successful
sync at **2026-07-30 10:00** (`inserted:3, duplicate:3726`), then nothing but
`Agent did not become reachable within 30 seconds` every 2 hours since. **The scheduled task's
"not reachable" message is misleading** — the agent process IS running and IS listening on 8787; it
just returns 503 because the device check fails, and `invoke-sync.ps1`'s `Ensure-Agent` treats any
non-200 as "not running" and pointlessly spawns another instance.

**Diagnose this before assuming a code/token bug:** curl the health endpoint and read `checks`.

## 2. ATTENDANCE_AGENT_TOKEN rotated — one step left, needs the owner

Rotated 2026-08-01 as part of the credential sweep. State:
- **Secret Manager v2** — clean, byte-verified 64 chars (per
  [[git-bash-crlf-corrupts-secrets-written-to-secret-manager]]).
- **Cloud Run prod** — revision `phoenix-hr-00272-r7l`, verified: prod returns 400 (auth passed) to
  the new token and 401 to the old one.
- **`local-attendance-agent/.env`** — updated in place; 12 lines and all 12 keys preserved, line
  endings untouched (regex `^ATTENDANCE_AGENT_TOKEN=[^\r\n]*` deliberately does not consume the
  line ending). Backup outside the repo at the session scratchpad
  (`attendance-agent.env.backup`) — **never back a `.env` up inside the repo**, a `.bak` may not
  match `.gitignore`.
- ❌ **The running agent process still holds the OLD token in memory.** It reads `.env` only at
  startup, and **PID 16812 could not be terminated** — both `Stop-Process -Force` and
  `taskkill /F` returned *Access is denied*, and its owner/cmdline/StartTime read back empty,
  indicating a higher integrity level than a normal non-elevated shell. The three
  `Phoenix Attendance *` scheduled tasks all run as `satoh` at `RunLevel=Limited`, so they are not
  what started it that way.

**To finish (owner action):** restart the agent so it reloads `.env` — easiest is a reboot (the
"Phoenix Attendance Agent - Run At Logon" task restarts it), or from an **elevated** PowerShell:
`Stop-Process -Id <pid> -Force`, then
`.\local-attendance-agent\start-agent.ps1 -SkipPrereqInstall`.
Until then, both directions are auth-mismatched — but since the device is unreachable anyway, no
sync is being lost that wasn't already stalled.

**Verify after restart:** `curl http://127.0.0.1:8787/health` → `tokenConfigured:true`; once back on
the office LAN, `deviceTcpReachable` should flip to true and a run of
`local-attendance-agent/invoke-sync.ps1` should log `Scheduled sync completed`.

Related: [[attendance-agent-x86-com-requirement]], [[attendance-eligibility-device-mapped]].
