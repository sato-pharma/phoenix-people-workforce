# Phoenix Windows Attendance Agent

Start:

```powershell
cd "F:\Phoenix Workforce\phoenix-workforce\local-attendance-agent"
.\start-agent.ps1
```

Health:

```powershell
curl.exe http://127.0.0.1:8787/health
```

Sync:

```powershell
$token = (Get-Content .\.env | Where-Object { $_ -match '^ATTENDANCE_AGENT_TOKEN=' }).Substring('ATTENDANCE_AGENT_TOKEN='.Length)

curl.exe -X POST http://127.0.0.1:8787/sync-now `
  -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" `
  -d "{}"
```

The agent reads ZKTeco logs from `SYNC_START_DATE=2026-01-01`, posts batches to Phoenix, and Phoenix stores only mapped active HR_ID punches.

Phoenix button:

1. Keep ZKTime closed.
2. Open `http://localhost:3000/attendance/device-user-mapping`.
3. Click `Sync Now`.

Phoenix calls its server-side `/api/attendance/sync-now` route. If the local agent is offline, Phoenix first tries to start `start-agent.ps1`, then calls this local agent at `http://127.0.0.1:8787/sync-now` using `ATTENDANCE_AGENT_TOKEN`. The token is not exposed to the browser.

Manual agent button:

Open `http://localhost:3000/attendance/device-user-mapping` and click `Run Local Agent`.

Windows automatic setup:

```powershell
cd "F:\Phoenix Workforce\phoenix-workforce\local-attendance-agent"
.\install-startup-shortcut.ps1
.\install-scheduled-tasks.ps1
```

The preferred setup installs a Windows startup shortcut. When Windows logs in, the agent starts and handles:

- manual Phoenix `Sync Now`
- automatic sync every 2 hours
- required daily sync at 5 PM

The automatic sync is controlled by:

```env
AUTO_SYNC_ENABLED=true
AUTO_SYNC_INTERVAL_MINUTES=120
AUTO_SYNC_REQUIRED_TIMES=17:00
```

If Windows Task Scheduler is allowed on the machine, `install-scheduled-tasks.ps1` also installs:

- `Phoenix Attendance Agent - Run At Logon`
- `Phoenix Attendance Sync - Every 2 Hours`
- `Phoenix Attendance Sync - Required 5 PM`

The scheduled sync script starts the agent if needed, then calls `/sync-now`. Logs are written to:

```text
local-attendance-agent\logs\scheduled-sync.log
```

To remove the scheduled tasks:

```powershell
cd "F:\Phoenix Workforce\phoenix-workforce\local-attendance-agent"
.\uninstall-scheduled-tasks.ps1
.\uninstall-startup-shortcut.ps1
```

Device read method:

```env
DEVICE_READ_METHOD=ssr
DEVICE_OPERATION_TIMEOUT_SECONDS=420
```

`ssr` is the default for this device because it preserves the correct punch timestamps. Use `DEVICE_READ_METHOD=legacy` only as a fallback if SSR cannot read the device.
