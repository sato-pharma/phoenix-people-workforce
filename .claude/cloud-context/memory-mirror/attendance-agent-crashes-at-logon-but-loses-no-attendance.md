---
name: attendance-agent-crashes-at-logon-but-loses-no-attendance
description: "Phoenix.Attendance.Agent.exe dies at EVERY logon with 0xE0434352 (unhandled .NET), but no attendance is lost - the 2-hourly sync task restarts it on demand and those runs succeed. The ZKTeco device is only reachable ~11:00-18:00 Cairo, so overnight sync failures are the network, not a bug."
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-20T23:37:13.273Z
  originSessionId: c72f79ce-ec2b-466e-899e-c2be583dc639
---

**Do not escalate this as "attendance is broken". It is not.** Verified 2026-08-26.

The logon scheduled task **`Phoenix Attendance Agent - Run At Logon`** runs
`local-attendance-agent/start-agent.ps1 -SkipPrereqInstall` and its
`LastTaskResult` is **`3762504530`, which is `0xE0434352` in decimal** — the CLR's
"unhandled managed exception" code. It failed identically after both boots on 2026-08-26
(crash logged 06:20:22 and 11:13:53, faulting module `KERNELBASE.dll`, exe
`F:\Phoenix Workforce\phoenix-workforce\local-attendance-agent\publish\win-x86\Phoenix.Attendance.Agent.exe`).

**Why it costs nothing:** `Phoenix Attendance Sync - Every 2 Hours` starts the agent on demand —
`logs/scheduled-sync.log` literally says *"Agent not listening on 127.0.0.1:8787; starting local
agent"* — and those runs succeed. On 2026-08-26 the 12:00 run inserted **19** rows and 14:00
inserted **1**, reading 5,406 records off the device. The agent was confirmed listening on
`127.0.0.1:8787` with one live process while the logon task's own attempt was dead.

**The overnight `503`s are the DEVICE, not the code.** Every failed run carries
`"Device TCP port is not reachable at 192.168.100.52:4370."`. Reachability across 08-25/08-26:

| Result | Cairo hours observed |
| --- | --- |
| **fails** | 00:00, 02:00, 04:00, 06:00, 08:00, 10:00 |
| **succeeds** | 12:00, 14:00, 16:00, 18:00 |

That is the fingerprint unit being off the reachable network outside office hours. **Do not "fix"
it, do not widen a timeout, and do not disable the task** — the 2-hourly cadence is what catches up
once the device returns, and duplicates are filtered (a typical run reports ~4,200 `duplicate`
against ~19 `inserted`).

**Where the crash is NOT.** `StartupValidator.CheckAsync` looks like the culprit and is not: it
*collects* into an `errors` list and never throws, and startup calls it with
`includeDeviceConnect: false`. Its own `zkemkeeper.dll` / device / Phoenix checks are all
non-fatal by design, and `/health` deliberately returns `degraded` rather than dying when the
device is offline. The throw is elsewhere in the top-level program (the file uses C# top-level
statements, so **any** uncaught throw in the body is an unhandled exception and this exact exit
code); `AgentConfig.FromEnvironment()` throwing on a missing `.env` key, and the port-8787 bind,
are the two candidates not yet ruled out.

**Do not reproduce it by launching a second agent.** `AUTO_SYNC_ENABLED=true` with
`AUTO_SYNC_INTERVAL_MINUTES=120`, so a fresh instance can fire a real sync that writes attendance
to PRODUCTION. Reproduce from the task's `LastTaskResult` and the Application event log instead.

Config lives in `local-attendance-agent/.env` (12 keys incl. `ATTENDANCE_AGENT_TOKEN`, `DEVICE_IP`,
`DEVICE_PORT`) and **survived the 2026-08-26 Windows reinstall** — the crash is not a missing config.

Related: [[commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb]]

## Narrowed 2026-08-26 15:20 - it is a DOUBLE-LAUNCH RACE, not a config throw

The 15:14 reboot produced the decisive timeline. **Two agent instances start, one wins the
`127.0.0.1:8787` bind and the loser dies ~5s later:**

| Time | Event |
| --- | --- |
| 15:15:07 | logon task starts `start-agent.ps1` (its host PID stayed alive) |
| 15:15:16 | an agent process starts - **PID 14976, still listening, 17 MB** |
| 15:15:21 | `Application Error` for `Phoenix.Attendance.Agent.exe` - the LOSER |

So the crash is a **second** instance failing to bind a port the first already holds, and
`start-agent.ps1` has no "is it already listening?" guard - it goes straight to
`& $PublishedExe`. `invoke-sync.ps1` DOES check (its log line *"Agent not listening on
127.0.0.1:8787; starting local agent"* is that check firing), which is why the sync path never
produces this crash and the logon path always does.

**This also explains the earlier reading of the same evidence being wrong.** On the 06:20 and
11:13 boots the crash was the only visible outcome and no agent survived, which looked like
"the agent cannot start when the device is unreachable". Device reachability is a real and
separate effect on the SYNC result, but it is not what kills the process. Do not fix a timeout.

**The fix is small and belongs in `start-agent.ps1`, not in `Program.cs`:** probe
`127.0.0.1:8787` first and exit 0 when something already answers, mirroring what
`invoke-sync.ps1` already does. Changing `Program.cs` to swallow the bind failure would hide a
genuine double-run instead of preventing it.

✅ **THAT FIX HAS LANDED — verified in the source 2026-09-21. Do not re-do it.**
`start-agent.ps1` lines 15–52 now carry the guard, headed
`# ONE AGENT AT A TIME - EXIT QUIETLY IF SOMETHING ALREADY HOLDS THE PORT`: a
`System.Net.Sockets.TcpClient` probe of `127.0.0.1:8787` with a 2s wait, and
*"Something is already listening on 127.0.0.1:8787 - leaving it alone and exiting."* It even carries
the caveat that a non-agent process holding 8787 is a different question. **So the CLR
`0xE0434352` double-launch crash is CLOSED**, which is why the 2026-09-20 agent death was
`0x8007042B` (the battery stop, below) and not the old race.

Still true regardless: **no attendance is lost** - the surviving instance serves the syncs.

## 2026-09-21 — there is a SECOND death cause, and it is not a crash at all

**`0x8007042B` is not the double-launch race.** The agent task's `LastTaskResult` on 2026-09-20 was
`0x8007042B` (`HRESULT_FROM_WIN32(1067)`, "the process terminated unexpectedly") — **not** the CLR's
`0xE0434352` documented above. Task Scheduler event **327** at 15:00:56 names the real reason in
plain words: *"stopped instance ... because the computer is switching to battery power."* That is the
`StopIfGoingOnBatteries` setting, measured **True** on all three tasks 2026-09-21 (with
`DisallowStartIfOnBatteries` also True and `StartWhenAvailable` False) — see
[[attendance-agent-needs-the-office-lan]], where the old "power settings are NOT the cause" line is
now corrected. **Read the event log before attributing a death to the bind race**: two different
causes produce two different codes, and only one of them is a bug.

**A failing 2-hourly run reports `2147942401` = `0x80070001` = `HRESULT_FROM_WIN32(1)`** — that is
just exit code 1 wrapped, the same thing `Get-ScheduledTaskInfo` shows as `0x00000001`. Not a
permissions fault.

🔴 **OWNER RULING 2026-09-21: leave all three tasks exactly as they are — "nothing is lost".** He was
shown both settings and the two events, and the reasoning that every run re-reads the whole device
buffer from `SYNC_START_DATE` and de-duplicates (the 2026-09-20 17:00 run recognised 4,747
duplicates against 2 inserts). The task named **`Required 5 PM`** is the one that matters and it
returned **code 0** that day. **Do not enable `StartWhenAvailable`, do not clear either battery flag,
and do not re-raise it** — changing settings on a live attendance task to close gaps that lose no
data is unrequested work on the path payroll reads.

**"Access is denied" never comes from these tasks.** Across a 30-hour event-log window there was no
access-denied and no launch-failure event for any of the three. All three run as `satoh` with
`LogonType Interactive, RunLevel Limited`, so a *start request* from an elevated or non-interactive
context is refused with that wording while the task itself is untouched — the string is about the
caller, never the sync. Check the task's own `LastTaskResult` and `scheduled-sync.log` before
believing it.

**The practical rule:** this pipeline only advances when the laptop is **plugged in AND on the office
LAN**. Off either, it stalls harmlessly and catches up in full on the next good run.

