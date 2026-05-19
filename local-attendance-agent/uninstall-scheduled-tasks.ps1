$ErrorActionPreference = "Stop"

$taskNames = @(
  "Phoenix Attendance Agent - Run At Logon",
  "Phoenix Attendance Sync - Every 2 Hours",
  "Phoenix Attendance Sync - Required 5 PM"
)

foreach ($taskName in $taskNames) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "[attendance-agent] Removed $taskName"
  }
}
