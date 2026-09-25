---
name: attendance-agent-x86-com-requirement
description: "ZKTeco attendance agent MUST run as 32-bit (win-x86); zkemkeeper.dll is x86-only COM, and the start-agent.ps1 dotnet-run fallback silently builds x64 and fails with 80040154."
metadata: 
  node_type: memory
  type: project
  originSessionId: 6b78f9fb-c62e-448c-8908-b2d214f1c31e
---

The local attendance agent (`local-attendance-agent/`) depends on the ZKTeco SDK
`zkemkeeper.dll`, which is registered **only in the 32-bit registry**
(`HKCR\WOW6432Node\CLSID\{00853A19-...}` → `C:\WINDOWS\SysWow64\zkemkeeper.dll`).
There is no 64-bit registration on the HR machine.

**Why:** A 64-bit process can resolve the ProgID (so the agent's `/health` reports
`sdkRegistered: true` — misleading) but `Activator.CreateInstance` fails with
`80040154 Class not registered`. `start-agent.ps1` prefers
`publish\win-x86\Phoenix.Attendance.Agent.exe`; if that folder is missing (it was
deleted in the 2026-06-09 disk cleanup) it silently falls back to `dotnet run`,
which builds AnyCPU/x64 → every device read 500s. This broke syncs from Jun 3–10,
2026 (punches stayed on the device; nothing lost — recovered with one sync after
republish).

**How to apply:** If attendance sync fails with "Class not registered" or
"Could not connect to fingerprint device" while TCP is reachable, first check
`Test-Path local-attendance-agent\publish\win-x86\Phoenix.Attendance.Agent.exe`.
If missing run `.\publish-agent.ps1` (defaults to win-x86), then restart the agent.
x86 ASP.NET Core 8 runtime lives at `C:\Program Files (x86)\dotnet`. Health-check
`deviceConnects` is always false (health never tests SDK connect) — not a signal.
Also: ZKTime must stay closed; agent token in repo `.env.local` and Vercel prod
env `ATTENDANCE_AGENT_TOKEN` match; agent `.env` posts to
`https://phoenix-workforce.vercel.app`. Related: [[windows-defender-dev-exclusions]].

## 2026-09-04 — the token location in the line above is dead infrastructure

**The x86/COM diagnosis and the whole `How to apply` recovery are unchanged and still correct.**
Verified on disk 2026-09-04: `publish-agent.ps1`, `start-agent.ps1` and `publish/` all still exist,
so the "republish win-x86, then restart" path works exactly as written.

**What is stale is the final clause only — `agent token in repo `.env.local` and Vercel prod`,
`https://phoenix-workforce.vercel.app`.** Vercel is fully decommissioned; that host does not resolve
and no environment variable lives there. `local-attendance-agent/Program.cs:74-76` allows exactly
three hosts today:

- `https://phoenix-hr.satopharma.com`
- `https://phoenix-people-workforce-production.up.railway.app`
- `https://phoenix-people-workforce-staging.up.railway.app`

So the production-side token is a **Railway** variable. The repo-side `.env.local` half is still
right. This memory survived three prior infrastructure sweeps because it is filed under *the
attendance agent*, not under *deployment* — the exact failure mode
[[staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones]] predicts.
