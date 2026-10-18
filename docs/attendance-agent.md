# Attendance Agent

## Overview

The local attendance agent is a separate .NET application that integrates with ZKTeco fingerprint devices. It runs on a Windows machine connected to the attendance hardware and syncs punch data to Phoenix Workforce.

## Location

`local-attendance-agent/` in the repository root. This is a standalone project with its own README, dependencies, and build process. It is **not** part of the Next.js application build.

## Architecture

1. ZKTeco device records fingerprint punches locally
2. The .NET agent reads punch logs from the device
3. Agent posts batches to the Phoenix API (`/api/attendance/raw-punches`, bearer-authed with `ATTENDANCE_AGENT_TOKEN`)
4. Phoenix maps `device_user_id` to employee `HR_ID` using the device-user-mapping table
5. Only mapped, active employees have their punches stored in `attendance_raw_punches`

## How the API stores a batch

The route accepts at most 1,000 punches a request and stores them through `insertRawPunches`
(`src/lib/attendance/raw-punch-batch.ts`):

- **Up to 250 punches per database call** to `public.phx_insert_attendance_raw_punches(p_rows jsonb)`, one
  `INSERT … SELECT FROM jsonb_to_recordset … ON CONFLICT DO NOTHING`. The function returns how many rows it
  inserted; the rest of the batch is reported as `duplicate`. A 1,000-punch request is four calls.
- **The conflict clause has no target on purpose**, so it covers both partial unique indexes
  (`attendance_raw_punches_idempotency_typed_idx` for a punch with a type, `…_null_type_idx` for one
  without) exactly as the single-row function does. A re-sent punch is a duplicate, never an error.
- **A batch that fails is retried punch by punch**, through `phx_insert_attendance_raw_punch`, at
  concurrency 10 (it was 50). That covers an error, a thrown request and an answer that is not a count
  between 0 and the batch size, and it means the route also works if it deploys before the migration. A
  failure is still reported against the punch's own position in the request (`input_index`), so the agent
  still knows which punches to send again. A batch is one statement, so a failed one wrote nothing. Any
  fallback is logged as a warning, `raw_punch_batch_fell_back` (batches fallen back, failures, punches): a
  missing function, or one punch the database refuses inside a batch the agent re-sends every run, would
  otherwise bring the 250-single-calls-per-batch load back with nothing to see.
- Both functions run as the caller, pin `search_path`, and are executable by `service_role` only.

**Why:** on 18 October 2026, 10:16-10:33 Cairo, the agent replayed punches the table already held and the
route answered with 10,461 single-row calls, fifty at a time, while production was entering the slowdown
that timed out logins from 10:30 to 11:55 (`docs/observability.md`, "18 October 2026").

**Not done:** a replay watermark on the agent side (`local-attendance-agent/`), so it stops re-sending
punches the server already holds. That is the .NET program on the office machine and ships separately.

## Setup

1. Navigate to `local-attendance-agent/`
2. Copy `.env.example` to `.env` and configure:
   - `ATTENDANCE_AGENT_TOKEN` -- shared secret with the Phoenix app. This is also the only thing
     authenticating step 3 above, so treat it as a payroll-write credential: **never** put it
     anywhere a browser can read it
   - `ATTENDANCE_AGENT_BROWSER_TOKEN` -- optional, and a *different* value. Phoenix hands this to the
     admin page so `Sync Now` can call the agent directly from the browser; it unlocks `/sync-now`
     alone. The agent refuses to start if it equals `ATTENDANCE_AGENT_TOKEN`
   - `SYNC_START_DATE` -- date to start syncing from
   - `AUTO_SYNC_ENABLED` -- enable automatic sync (default: true)
   - `AUTO_SYNC_INTERVAL_MINUTES` -- sync interval (default: 120)
   - `AUTO_SYNC_REQUIRED_TIMES` -- required daily sync times (default: 17:00)
3. Run the agent: `.\start-agent.ps1`

## Phoenix Integration

The Phoenix app can trigger syncs from the UI:

1. Navigate to `/attendance/device-user-mapping`
2. Click **Sync Now** to trigger a manual sync
3. The app calls the local agent via the `ATTENDANCE_AGENT_LOCAL_URL` environment variable

## Device-User Mapping

After syncing, unmapped device users appear in the mapping interface at `/attendance/device-user-mapping`. Assign each numeric `device_user_id` to an employee `HR_ID` and keep the mapping active. Only active mappings with a valid `employees.hr_id` resolve during ingestion.

## Windows Automatic Setup

For automatic startup and scheduled syncs:

```powershell
cd local-attendance-agent
.\install-startup-shortcut.ps1
.\install-scheduled-tasks.ps1
```

This installs a Windows startup shortcut so the agent starts on login.

**`Phoenix Attendance Sync - Every 2 Hours` runs in office hours only** — every 2 hours inside a
window that opens at 10:30 and closes 7 hours later (10:30, 12:30, 14:30, 16:30), with
`Phoenix Attendance Sync - Required 5 PM` as the backstop. The sync talks to the ZKTeco device on
the office LAN, so a run from anywhere else exits 1 with "Device TCP port is not reachable"; with
the old around-the-clock schedule those fires produced 0 successes in 69 attempts over a fortnight
(measured 2026-09-21), which left a red task that meant nothing. Nothing is lost by skipping them:
each successful sync reads the device's whole buffer, so one good run catches the day up. Override
with `-SyncWindowStart` / `-SyncWindowHours`.

**The agent rebuilds its own `publish\win-x86\` when files are missing.** `start-agent.ps1` calls
`ensure-published.ps1` before it launches: if the `.exe`, `.dll`, `runtimeconfig.json` or `deps.json`
is absent it runs `publish-agent.ps1`, behind a named mutex (the logon task and the startup shortcut
both start the agent at logon), and refuses to launch if the folder is still incomplete. Each repair
is written to `logs\agent-republish.log`. Why: on 2026-10-12 the folder held only the `.exe` and
`.dll`, every start died with "hostpolicy.dll ... was not found", and no punches were read between
2026-10-06 17:00 and 2026-10-12 13:18 Cairo. Pinned by `tests/attendance-agent-self-republish.test.ts`.

## Environment Variables (Phoenix Side)

See the "Attendance Agent" section in [docs/environment.md](environment.md) for the Phoenix-side variables (`ATTENDANCE_AGENT_LOCAL_URL`, `ATTENDANCE_AGENT_TOKEN`, etc.).

## Not Required for General Development

The attendance agent is only needed when working on attendance features or testing the ZKTeco integration. Most developers do not need to set it up.
