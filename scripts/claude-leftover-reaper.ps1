<#
.SYNOPSIS
  Stops the git file-watcher daemons of worktrees nobody is using (owner, 2026-11-07: "Both" -
  cloud-first routing plus the auto-cleanup, on a 16 GB laptop that is not being upgraded).

  The repo has core.fsmonitor=true, so every worktree that ever ran a git command keeps one
  `git fsmonitor--daemon` alive until reboot - 33 of them on 2026-11-07 (157 MB private), one per
  worktree. Stopping one is harmless: git starts it again on that worktree's next command.

  A daemon is stopped ONLY for a worktree whose index has not changed for -IdleMinutes, so a
  worktree in active use keeps its watcher. It never touches a session, a shell, a dev server or
  any process other than through `git fsmonitor--daemon stop` itself, and it runs at most once an
  hour (state file), however often the task fires.

.EXAMPLE
  .\claude-leftover-reaper.ps1            # dry run: shows which watchers it would stop
  .\claude-leftover-reaper.ps1 -Apply     # stops them
#>
param([int]$IdleMinutes = 60, [int]$EveryMinutes = 60, [switch]$Apply)

$ErrorActionPreference = 'Continue'
$repos = @('F:\Phoenix Workforce\phoenix-workforce', 'F:\Safety Notifications')
$logFile = Join-Path $env:USERPROFILE '.claude\logs\claude-leftover-reaper.log'
$stateFile = Join-Path $env:USERPROFILE '.claude\scripts\claude-leftover-reaper.state'
function Write-Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Output $line
  if ($Apply) { Add-Content -LiteralPath $logFile -Value $line -Encoding utf8 }
}

if ($Apply -and (Test-Path -LiteralPath $stateFile)) {
  $last = (Get-Item -LiteralPath $stateFile).LastWriteTime
  if (((Get-Date) - $last).TotalMinutes -lt $EveryMinutes) { exit 0 }
}
$before = @(Get-Process git -ErrorAction SilentlyContinue).Count
if ($before -eq 0) { if ($Apply) { Set-Content -LiteralPath $stateFile -Value (Get-Date -Format o) }; exit 0 }

$stopped = 0; $kept = 0
foreach ($repo in $repos) {
  if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { continue }
  $wts = @(git -C $repo worktree list --porcelain 2>$null | Where-Object { $_ -like 'worktree *' } | ForEach-Object { $_.Substring(9) })
  foreach ($wt in $wts) {
    if (-not (Test-Path -LiteralPath $wt)) { continue }
    $gitDir = git -C $wt rev-parse --absolute-git-dir 2>$null
    if (-not $gitDir) { continue }
    $index = Join-Path $gitDir 'index'
    $idle = if (Test-Path -LiteralPath $index) { ((Get-Date) - (Get-Item -LiteralPath $index).LastWriteTime).TotalMinutes } else { [double]::MaxValue }
    if ($idle -lt $IdleMinutes) { $kept++; continue }
    $status = git -C $wt fsmonitor--daemon status 2>&1 | Out-String
    if ($status -notmatch 'is watching') { continue }
    if (-not $Apply) { Write-Output ("WOULD STOP watcher: {0} (index idle {1:N0} min)" -f $wt, $idle); $stopped++; continue }
    git -C $wt fsmonitor--daemon stop 2>&1 | Out-Null
    $stopped++
  }
}
Start-Sleep -Seconds 2
$after = @(Get-Process git -ErrorAction SilentlyContinue).Count
$verb = if ($Apply) { 'stopped' } else { 'would stop' }
Write-Log ("git watchers: {0} {1}, {2} in use kept; git processes {3} -> {4}" -f $verb, $stopped, $kept, $before, $after)
if ($Apply) { Set-Content -LiteralPath $stateFile -Value (Get-Date -Format o) }
