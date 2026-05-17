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
