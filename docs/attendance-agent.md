# Attendance Agent

## Overview

The local attendance agent is a separate .NET application that integrates with ZKTeco fingerprint devices. It runs on a Windows machine connected to the attendance hardware and syncs punch data to Phoenix Workforce.

## Location

`local-attendance-agent/` in the repository root. This is a standalone project with its own README, dependencies, and build process. It is **not** part of the Next.js application build.

## Architecture

1. ZKTeco device records fingerprint punches locally
2. The .NET agent reads punch logs from the device
3. Agent posts batches to the Phoenix API (`/api/attendance/sync`)
4. Phoenix maps `device_user_id` to employee `HR_ID` using the device-user-mapping table
5. Only mapped, active employees have their punches stored in `attendance_raw_punches`

## Setup

1. Navigate to `local-attendance-agent/`
2. Copy `.env.example` to `.env` and configure:
   - `ATTENDANCE_AGENT_TOKEN` -- shared secret with the Phoenix app
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

## Environment Variables (Phoenix Side)

See the "Attendance Agent" section in [docs/environment.md](environment.md) for the Phoenix-side variables (`ATTENDANCE_AGENT_LOCAL_URL`, `ATTENDANCE_AGENT_TOKEN`, etc.).

## Not Required for General Development

The attendance agent is only needed when working on attendance features or testing the ZKTeco integration. Most developers do not need to set it up.
