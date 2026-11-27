# Owner, 24 Nov 2026: "retire the empty worktree folders once these two sessions are closed".
# Removes each folder ONLY when it is empty (Remove-Item on an empty dir; a non-empty one is left alone),
# and deletes its own scheduled task once both are gone.
$root = 'F:\Phoenix Workforce\phoenix-workforce\.claude\worktrees'
$names = @('dev-server-visibility-42ad7b', 'saeed-visits-today-6e9fb7')
$log = 'C:\Users\satoh\.claude\scripts\retire-empty-worktree-folders.log'
$left = 0
foreach ($n in $names) {
  $p = Join-Path $root $n
  if (-not (Test-Path -LiteralPath $p)) { continue }
  if (@(Get-ChildItem -LiteralPath $p -Force).Count -gt 0) { Add-Content $log "[$(Get-Date -f 'yyyy-MM-dd HH:mm')] $n not empty - left alone"; continue }
  try { [System.IO.Directory]::Delete($p, $false); Add-Content $log "[$(Get-Date -f 'yyyy-MM-dd HH:mm')] $n removed" }
  catch { $left++; Add-Content $log "[$(Get-Date -f 'yyyy-MM-dd HH:mm')] $n still held by an open session" }
}
if ($left -eq 0) { schtasks /Delete /TN 'Phoenix Retire Empty Worktree Folders' /F | Out-Null; Add-Content $log "[$(Get-Date -f 'yyyy-MM-dd HH:mm')] done - task removed" }
