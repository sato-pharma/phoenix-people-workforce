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

1. Keep this agent running.
2. Keep ZKTime closed.
3. Open `http://localhost:3000/attendance/device-user-mapping`.
4. Click `Sync Now`.

Phoenix calls its server-side `/api/attendance/sync-now` route, which calls this local agent at `http://127.0.0.1:8787/sync-now` using `ATTENDANCE_AGENT_TOKEN`. The token is not exposed to the browser.

Device read method:

```env
DEVICE_READ_METHOD=ssr
DEVICE_OPERATION_TIMEOUT_SECONDS=420
```

`ssr` is the default for this device because it preserves the correct punch timestamps. Use `DEVICE_READ_METHOD=legacy` only as a fallback if SSR cannot read the device.
