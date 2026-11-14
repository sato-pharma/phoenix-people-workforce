---
name: attendance-agent-needs-the-office-lan
description: "Punch ingestion silently stops whenever the owner's laptop leaves the office LAN — the ZKTeco device is at 192.168.100.52:4370 and nothing else can reach it"
metadata: 
  node_type: memory
  type: project
  originSessionId: d0007173-7b15-4def-a4c3-f0d0670c67f0
  modified: 2026-11-14T02:01:19.543Z
---

Fingerprint punch ingestion runs from a **local .NET agent on the owner's laptop**
(`local-attendance-agent/`, listens on `127.0.0.1:8787`). It reads the ZKTeco device at
**`192.168.100.52:4370`** and posts to `/api/attendance/raw-punches`.

The device is only reachable from the office LAN (`192.168.100.x`). When the laptop is elsewhere —
home Wi-Fi was `192.168.1.21` on 2026-08-08 — ping and TCP both fail and **ingestion stops with no
user-visible sign**. It stopped 2026-07-30 10:00 Cairo and was still dead 9 days later; payroll
attendance was running on stale data the whole time. It stopped again 2026-08-20 20:00 Cairo and
was restarted by hand on 2026-08-23 09:48 (backfilled 23 punches: 13 Thursday-evening + 10 Sunday).
**Note `PingSucceeded` is `False` even when healthy** — the device drops ICMP. Only
`TcpTestSucceeded` means anything.

`invoke-sync.ps1` used to log the failure as "Agent not reachable" and spawn a second agent; fixed
in PR #1886 so the log now names the device.

**The published exe is NOT rebuilt when `Program.cs` changes, and nothing warns.**
`publish/win-x86/Phoenix.Attendance.Agent.exe` sat on the **2026-06-10** build until 2026-08-23,
predating `bf06d67c` (2026-06-17, "honest health") by a week — the fix was dormant for over two
months with no signal anywhere. **Rebuilt and republished 2026-08-23 10:01 Cairo**; `/health` now
returns `deviceConnects: true`, which the old build could never produce.

Read `deviceConnects` carefully by build: the pre-`bf06d67c` binary calls
`CheckAsync(includeDeviceConnect: false)`, so the field is **hardcoded `false` and never tested** —
"not evaluated", NOT a device fault. That build also returned `status:"ok"` on TCP alone, so it
said OK while the SDK session could be dead. The current build genuinely opens a device session and
returns `degraded` + HTTP 503 when it cannot.

**How to rebuild** (~40s total, needs the .NET 8 SDK — 8.0.421 is installed):
`build-agent.ps1`, then stop the agent, then `publish-agent.ps1 -Runtime win-x86`, then restart.
Order matters: **`publish-agent.ps1` deletes the whole `publish/win-x86` folder**, so it fails on the
locked exe unless the agent is stopped first (`Stop-ScheduledTask 'Phoenix Attendance Agent - Run At
Logon'` + `Stop-Process`, then `Start-ScheduledTask`). That folder holds build output ONLY — no
`.env`, nothing git-tracked — so wiping it is safe; the token lives in `local-attendance-agent/.env`
at the agent root. Every build artifact (`bin/ obj/ publish/ .dotnet-home/ .nuget/ .appdata/`) is
gitignored, so a rebuild leaves the working tree clean. **Check no sync is mid-flight first** — the
2-hourly task holds the agent for ~30s per run.

**A scheduled sync can be REFUSED, and it looks like a failure that it is not.** The task is
`MultipleInstances: IgnoreNew`, so a run requested while one is in flight is refused with
LastTaskResult **2147946720 / 0x800710E0** and writes **NOTHING to scheduled-sync.log** — no
"started" line at all, which is how to tell it apart from a sync that ran and failed (those
always log a cause). Seen 2026-08-23 12:27; the trigger is a manual sync overlapping the
2-hourly one, since the agent serialises device access behind a lock. **It costs no data**:
every run re-reads the whole device log from `SYNC_START_DATE`, so the next run backfills.
**A NON-EMPLOYEE DEVICE USER CANNOT BE MAPPED AT ALL — the schema forbids it.**
`attendance_device_user_map` has TWO constraints that together close the door:
`employee_hr_id` is a FK to `employees(hr_id)` (ON DELETE CASCADE), and CHECK
`attendance_device_user_map_active_requires_employee` = `(is_active = false OR employee_hr_id IS NOT NULL)`.
So there is no legal value for a guard/driver/cleaner/outsourced person, and the row cannot be
activated without one. `resolveDeviceMappingStatus` in `src/lib/attendance/metrics.ts` has only three
states — `!employeeHrId` is ALWAYS `unmapped` — so there is no way to record "known, deliberately not
an employee". Such an id shows as unmapped forever and drags `readinessRate` in the admin dashboard.
**Owner said 2026-08-23 that device id 18 is a DRIVER.** He is not in `employees` (no driver title
exists at all; every ACTIVE head-office employee already holds a device id — both Admin Assistants are
2 and 45, Buffet is 15). Id 18 therefore stayed `employee_hr_id = NULL, is_active = false`, which is
the CORRECT data state: his punches are skipped and no attendance is corrupted. **Do NOT create an
employee row to satisfy the FK**, and do NOT map him to the `O-3 Others / Unassigned` placeholder —
that would put a non-payroll person into headcount, organogram and payroll exports. Closing this
Built as **PR #2335** (branch `codex/attendance-non-employee-device-users`): migration
`20260823170000_attendance_non_employee_device_users.sql` adds `non_employee_label`, a CHECK
`attendance_device_user_map_non_employee_exclusive` making it exclusive with `employee_hr_id` and
pinned to `is_active = false`, a fourth status `non_employee`, and seeds id 18 as `Driver`.
**APPLIED TO PRODUCTION 2026-08-23 16:23 Cairo** (ref `ozucdzovmcqvepbozvqf`, owner-approved).
Verified against `pg_attribute`/`pg_constraint`, not the ledger: column live, constraint live, id 18
reads `label=Driver hr_id=NULL active=false`, 25 rows unchanged, no other row touched. All three
illegal writes are REJECTED by the DB — activating id 18 (23514 on `active_requires_employee`),
attaching an employee to a labelled row, and a whitespace-only label (both 23514 on
`non_employee_exclusive`). **MERGED AND LIVE 2026-08-23**: squash `f681f919`, serving production 16:30:58 Cairo (healthz
revision flipped from `e510ad52`). PostgREST serves the new column on ref `ozucdzovmcqvepbozvqf` —
verified through the REST path the app actually uses, not just SQL. **Send `notify pgrst, 'reload
schema';` after adding a column any Supabase select reads**: PostgREST caches the schema and would
otherwise answer "column does not exist in schema cache" while the column plainly exists in
`pg_attribute`. Live counts now 17 active / 7 unmapped / 1 non_employee of 25; readiness 68% -> 72%.
**DEPLOY ORDER MATTERED: the migration went FIRST, before merging.** Two read paths select
the new column (`device-user-mapping.ts` and the admin data-health query in `admin/service.ts`), and
Railway applies no migrations on deploy — merging first breaks both pages until the column exists.
`saveAttendanceDeviceUserMapping` takes the label as OPTIONAL with omit-on-undefined semantics,
because the bulk XLSX upload calls it without knowing the field exists and would otherwise wipe every
label on every upload — the `optional-field-written-unconditionally-is-a-silent-erase` trap again.
**OWNER RULE 2026-08-23: EXECUTIVES DO NOT USE THE FINGERPRINT.** `AA` Anwar Gaweesh (CEO),
`AB` Sahar Khalil (R&D Manager) and `OF-0002` Adel El Sayed (Financial Advisor) never punch.
Never offer them as the owner of an unmapped device id. This killed an otherwise clean inference:
every ACTIVE `A-*` head-office employee is already mapped, so "unmapped head-office employee" looked
like it had to be one of those three — AA even had 30 system events on 2026-08-17, the day id 18
punched, with zero punches of his own. **That reasoning is void.** Whoever owns id 18 is outside the
head-office employee set entirely: a guard/cleaner/driver/outsourced person not in `employees`, or a
Cairo field rep who visits HQ. Also do NOT infer enrolment order from the device id — they are not
chronological (`A-16`, hired Nov 2025, is device **377**).
The decision workbook `xlsx/Fingerprint device IDs - who is this.xlsx` was REBUILT 2026-08-23 with
the executives removed from the dropdown, live `last_seen_punch_at` per id, and a LIVE/RECENT/DORMANT
split: **only id 18 is live** (6 days), 13 and 44 are recent, the other five are 5-8 months dead.
Build script: `scratchpad/build_device_map_xlsx_v2.py`. Its `Detected On` column is when ingestion
first NOTICED the id (bulk pass 2026-05-18), NOT its first punch — it legitimately post-dates the
last punch for old ids. Use `zoneinfo("Africa/Cairo")`, never a fixed UTC+3: Egypt is UTC+2 in
winter, so a fixed offset silently shifts every Jan-Mar timestamp by an hour.

Do not chase it as an outage — the LAN is the usual cause.

🔴 **14 Nov 2026 — "the office LAN" is ONE Wi-Fi name, `605`, and being in the building is not
enough.** Matched every scheduled run since 16 Oct 2026 to the Wi-Fi the laptop was on at that
minute: `605` read the device on 38 of 41 runs; `606` failed 15 of 15, `GEO` 2 of 2, and every home
or phone network failed. So a day on `GEO` or `606` is a day with no punches, even though it looks
like an office day. **The one read that answers "why did day X not arrive":** event 10000 in
`Microsoft-Windows-NetworkProfile/Operational` (the log goes back about a month) names each network
joined and when; no `605` row on that day is the whole answer. The Task Scheduler log keeps only a
couple of hours, so it cannot answer for a past day.

The case: Thursday 12 Nov 2026 had zero punches in production. The laptop was on home Wi-Fi until
11:28, then on `GEO` until 20:16, and never joined `605`; it also slept or was off at four of the
five sync slots. The last good read was Wed 11 Nov 18:17 on `605`, so Wednesday's evening punches
(after 17:42) were missing too. Nothing was lost (the device held 6,954 records from 1 Jan) and
nothing was charged: a working day with zero punches is skipped by `getCompanyWideOutageDates`.
A PARTIAL day is not protected the same way — Wednesday had two unreleased, unticked "short hours"
review lines that could be artefacts of the missing evening punches; the twice-daily review sync
re-reads them once the punches arrive.

The agent's "Phoenix is not reachable" line is a 5-second probe (`Program.cs`,
`CanReachHttpAsync`), so a slow answer reads as unreachable. It appeared on all four runs of
Fri 13 Nov while production was serving normally. Read it as slow, not down.

🔴 **CORRECTED 2026-09-21: POWER SETTINGS *ARE* A CAUSE. The old line here said they were not, and
it read the wrong flag.** Measured live 2026-09-21 02:30 Cairo, all three
`Phoenix Attendance *` tasks:

| Setting | Value |
| --- | --- |
| `DisallowStartIfOnBatteries` | **True** |
| `StopIfGoingOnBatteries` | **True** |
| `StartWhenAvailable` | **False** |

The 2026-08-23 note recorded `DisallowStartIfOnBatteries: False`, which is the **opposite** of the
live value — most likely the 2026-08-26 Windows reinstall re-created the tasks from
`install-scheduled-tasks.ps1`, which sets neither flag, so both reverted to the Windows default of
True. Do not trust the old reading, and **re-measure both flags rather than either one.**

Two Task Scheduler events prove each flag firing, in
`Microsoft-Windows-TaskScheduler/Operational`:
- **Event 327**, 2026-09-20 15:00:56 — *"stopped instance of task `Phoenix Attendance Agent - Run At
  Logon` because the computer is switching to battery power"*, return code `2147943691`
  (`0x8007050B`). That is `StopIfGoingOnBatteries`, **not** the CLR crash in
  [[attendance-agent-crashes-at-logon-but-loses-no-attendance]].
- **Event 153**, 2026-09-20 18:58:52 — the 18:00 2-hourly slot *"did not launch ... as it missed its
  schedule"*. With `StartWhenAvailable: False` a dropped slot is **never retried**.

So on battery the sync does not merely fail, it is **not allowed to start at all**, and the slot is
lost. It still costs no data (every run re-reads the whole device log from `SYNC_START_DATE`), which
is why the owner ruled on **2026-09-21** to leave all three tasks exactly as they are — see the same
ruling in [[attendance-agent-crashes-at-logon-but-loses-no-attendance]]. **Do not "fix" these three
settings, and do not re-propose it.**

**The `attendance_ingestion_alert` policy is `enabled: true`** — re-enabled 2026-08-09 12:26 Cairo
by `B-10`, roles `["Super Admin"]`. (It was `false` from 2026-07-24; any note still saying the
alert reaches nobody is stale.) It is **weekend-aware by design**: `missedWorkingDays` counts only
fully-elapsed working days **through yesterday**, skipping Fri/Sat, and today is deliberately
excluded because the check runs ~06:00 Cairo. So a Thu-night → Sun-morning outage scores 0 and
stays "healthy" — correctly, not as a bug. Emails were retired 2026-08-08 (in-app + push only).

Deductions for a dead window are protected by `getCompanyWideOutageDates` — never delete it.

**Why:** the whole pipeline depends on one laptop's physical network, which no runbook mentions and
no dashboard shows.
**How to apply:** if punches stop, check `Test-NetConnection 192.168.100.52 -Port 4370` from the
laptop BEFORE suspecting code, cron or Railway, and read `logs/scheduled-sync.log` — it names the
real cause per 2-hour run. Reconnecting to the office LAN and running `.\invoke-sync.ps1` backfills
from `SYNC_START_DATE`. 8 of 25 device users in `attendance_device_user_map` have a NULL
`employee_hr_id` — their ~287 punches are skipped on every sync and never reach attendance.
**Device id 44 is explained**: all 74 of its punches carry `B-157` Sameh Ahmed Ezzat (National
Sales Manager, resigned); he was re-enrolled as device id **46** on 2026-06-03, so 44 is his
orphaned old id. The other **7 (13/18/30/36/38/40/41)** are genuinely unknown, and **the device
cannot name them**. They have NOT "never punched" (an earlier note said so and was wrong):
skipped punches are never stored, so `attendance_raw_punches` shows 0 for them, but
`attendance_device_user_map.last_seen_punch_at` proves every one HAS punched — **id 18 as
recently as 2026-08-17 09:17**, i.e. someone currently working whose attendance is being
discarded. Rank them by that column, never by a punch count.
**All 8 rows are `is_active = false`, and `resolveMappedHrIds` filters `.eq("is_active", true)`
AND `.not("employee_hr_id","is",null)` — so filling in `employee_hr_id` alone fixes NOTHING;
`is_active` must be flipped true in the same write.**
The **22 device ids enrolled with NO map row at all** (3,5,7,8,9,10,11,12,16,17,19,20,21,22,23,
24,27,28,29,31,32,43 — four of them device admins) have genuinely never punched since
`SYNC_START_DATE`: `recordUnmappedDeviceUsers` auto-creates a NULL row the first time an
unmapped id punches, so no row means no punch. Dormant enrolments, not a data gap. `GET /device-users` (added 2026-08-23,
PR #2325, merged to main 2026-08-23 13:26 Cairo as `efe82684`; bearer-gated, localhost) reads
the enrolled list straight off the ZKTeco: **47 users
enrolled vs 17 mapped, 6 device admins, and every single `name` field EMPTY** — this device was
enrolled with ids only. Do not re-litigate this by "reading the names off the device"; they are
not there. Identifying an id needs a human, or watching who punches next.
**Deployed to the office agent 2026-08-23 13:45 Cairo** (rebuilt from `efe82684`, exe sha256
`895D119A…`, PID 29000). Live proof: `/device-users` went 404 -> 401 unauthenticated, and 200
with the token returning 47 users / 6 admins / 0 names, no `password` field. Merging is NOT
deploying here — the exe had to be republished by hand; that is the same trap as the
two-month-stale binary above.
Two traps that endpoint cost: the legacy `GetAllUserID` takes `ref string`, which **cannot be
marshalled through C# dynamic COM dispatch** ("Could not convert argument 3") — use
`SSR_GetAllUserInfo`, whose out-params marshal fine, regardless of `DEVICE_READ_METHOD`. And the
agent binds `ASPNETCORE_URLS` only when it is unset, so a second build can be tested on another
port (8799) **without stopping the production agent on 8787**.
Asked as `xlsx/Fingerprint device IDs - who is this.xlsx` (2026-08-23, dropdown of 139 unmapped
employees). Note **`*.xlsx` is gitignored at `.gitignore:45`** — files dropped in `xlsx/` never
dirty the working tree, which is why that folder is safe to use while another session is live.
