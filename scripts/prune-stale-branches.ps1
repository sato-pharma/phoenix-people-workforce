<#
.SYNOPSIS
  Safely reduce remote branch sprawl: mirror every remote branch tip to
  refs/backups/* on origin (recoverable forever), then delete remote branches
  that are already merged into origin/main.

.DESCRIPTION
  Dry-run by default — prints exactly what it WOULD back up and delete and
  changes nothing. Pass -Execute to perform the backup + deletion.

  Always protected (never deleted): origin/main, the active fixation branch,
  the parallel outstation branches, and anything under backup/ recover/ safety/
  archive/ (those are already recovery refs). Pass -PruneRecoveryRefs to also
  delete the old backup/recover/safety/archive branches (they are re-backed-up
  to refs/backups/* first).

  Unmerged branches are NEVER deleted unless -IncludeStaleUnmerged is set and
  the branch's last commit is older than -StaleDays days. They are always
  backed up regardless.

.EXAMPLE
  pwsh scripts/prune-stale-branches.ps1               # dry run, shows the plan
  pwsh scripts/prune-stale-branches.ps1 -Execute      # back up + delete merged

.NOTES
  Recovery of any deleted branch:
    git fetch origin "refs/backups/*:refs/backups/*"
    git branch <name> refs/backups/<name>
#>
[CmdletBinding()]
param(
  [switch]$Execute,
  [switch]$IncludeStaleUnmerged,
  [switch]$PruneRecoveryRefs,
  [int]$StaleDays = 30
)

$ErrorActionPreference = 'Stop'

$keep = @(
  'main',
  'codex/health-fixation-20260615',     # this fixation branch
  'codex/outstation-expense-rescue',    # active parallel session
  'codex/outstation-expense-report-fields' # PR #129 head
)
$recoveryPrefixes = @('backup/', 'recover/', 'safety/', 'archive/')

function Is-Protected([string]$name) {
  if ($keep -contains $name) { return $true }
  if (-not $PruneRecoveryRefs) {
    foreach ($p in $recoveryPrefixes) { if ($name.StartsWith($p)) { return $true } }
  }
  return $false
}

Write-Host "Fetching + pruning origin..." -ForegroundColor Cyan
git fetch --prune origin | Out-Null

# All remote branches (strip the leading "origin/"), excluding origin/HEAD.
$allRemote = git for-each-ref --format='%(refname:short)' refs/remotes/origin |
  Where-Object { $_ -ne 'origin/HEAD' } |
  ForEach-Object { $_ -replace '^origin/', '' }

# Branches whose tip is already contained in origin/main.
$merged = (git branch -r --merged origin/main |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ -and $_ -ne 'origin/HEAD' -and $_ -notmatch '->' } |
  ForEach-Object { $_ -replace '^origin/', '' })

$toBackup = @()
$toDelete = @()
$staleCandidates = @()
$cutoff = (Get-Date).AddDays(-$StaleDays)

foreach ($name in $allRemote) {
  if (Is-Protected $name) { continue }
  $toBackup += $name
  if ($merged -contains $name) {
    $toDelete += $name
  } else {
    $lastIso = git log -1 --format='%cI' "origin/$name" 2>$null
    $isStale = $false
    if ($lastIso) { try { $isStale = ([datetime]$lastIso) -lt $cutoff } catch {} }
    if ($isStale) {
      $staleCandidates += $name
      if ($IncludeStaleUnmerged) { $toDelete += $name }
    }
  }
}

Write-Host ""
Write-Host "Total remote branches: $($allRemote.Count)" -ForegroundColor White
Write-Host "Protected (kept):       $($allRemote.Count - $toBackup.Count)"
Write-Host "Will back up:           $($toBackup.Count)  -> refs/backups/<name> on origin"
Write-Host "Merged into main:       $(@($merged | Where-Object { -not (Is-Protected $_) }).Count)"
Write-Host "Stale unmerged (>$StaleDays d): $($staleCandidates.Count)  (deleted only with -IncludeStaleUnmerged)"
Write-Host "Will DELETE:            $($toDelete.Count)" -ForegroundColor Yellow
Write-Host ""
if ($toDelete.Count) { Write-Host "Delete list:"; $toDelete | Sort-Object | ForEach-Object { Write-Host "  - $_" } }
if (-not $IncludeStaleUnmerged -and $staleCandidates.Count) {
  Write-Host ""
  Write-Host "Stale-unmerged candidates (NOT deleted; re-run with -IncludeStaleUnmerged to remove):" -ForegroundColor DarkYellow
  $staleCandidates | Sort-Object | ForEach-Object { Write-Host "  ? $_" }
}

if (-not $Execute) {
  Write-Host ""
  Write-Host "DRY RUN — nothing changed. Re-run with -Execute to back up + delete." -ForegroundColor Green
  return
}

Write-Host ""
Write-Host "Backing up $($toBackup.Count) branch tips to refs/backups/* on origin..." -ForegroundColor Cyan
foreach ($name in $toBackup) {
  git push --force origin "refs/remotes/origin/${name}:refs/backups/${name}" | Out-Null
}

Write-Host "Deleting $($toDelete.Count) merged/stale remote branches..." -ForegroundColor Yellow
foreach ($name in $toDelete) {
  git push origin --delete $name | Out-Null
  Write-Host "  deleted origin/$name"
}

Write-Host ""
Write-Host "Done. Recover any branch with:" -ForegroundColor Green
Write-Host '  git fetch origin "refs/backups/*:refs/backups/*"; git branch <name> refs/backups/<name>'
