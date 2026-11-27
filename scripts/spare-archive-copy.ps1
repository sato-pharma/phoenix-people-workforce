<#
  Nightly second copy of the owner's document archives on the spare laptop (owner, 2026-11-23: "Do 5, 27, 30" - #27).
  Run by the scheduled task "Phoenix Spare Archive Copy" at 02:30 Cairo; a first copy can be started by hand the same way.

  WHAT IS COPIED, to /home/phoenix/archive-copy/ on the spare (its own ext4 disk, 146 GB free on 23 Nov):
    F:\Claude Scratchpad Archive                 -> claude-scratchpad-archive/   (about 11 GB on 23 Nov)
    F:\Phoenix Workforce\phoenix-workforce\xlsx  -> phoenix-xlsx/                 (the WHOLE folder, subfolders included -
                                                    the repo's own snapshot copies only the top level and two subfolders)
    F:\PHX backup\05-data-files                  -> phx-backup-data-files/        (the dated Excel snapshots)

  🔴 IT NEVER DELETES - not here, not on the spare. `rclone copy` adds new files and replaces changed ones; a file removed
  here stays on the spare. Excel's ~$ lock files are left out. Nothing here is read for any other purpose.
  The copy goes over the same ssh login as the tunnel (Windows OpenSSH, host phoenix-spare in ~/.ssh/config), so the
  spare's firewall needs nothing new. Log: ~/.claude/logs/spare-archive-copy.log
  🔴 THE WI-FI BETWEEN THE LAPTOPS CARRIES ONLY ABOUT 0.7 MB A SECOND (23 Nov, through the extender). An uncapped copy
  made localhost:3000 answer in 5-9 s and the ping 2.8 s, so the copy is capped at 300 KB/s (-Limit) and stops after 4
  hours (-Minutes): the first 11 GB takes about three nights, after that a night carries only the new files. Each file is
  checked by size and time, not by checksum (disable_hashcheck): a checksum costs one ssh login per file.
#>
param([switch]$DryRun, [int]$Minutes = 240, [string]$Limit = '300k')
$ErrorActionPreference = 'Stop'
$log = Join-Path $env:USERPROFILE '.claude\logs\spare-archive-copy.log'
function Log([string]$m) { $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Add-Content -LiteralPath $log -Value $line; Write-Output $line }
$rclone = (Get-Command rclone -ErrorAction SilentlyContinue).Source
if (-not $rclone) { $rclone = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter rclone.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
if (-not $rclone) { Log 'archive copy NOT run: rclone.exe not found'; exit 1 }
# The checksum commands are named on purpose: left to detect them, rclone runs a bare `md5sum` over ssh and waits for
# an end of input that Windows OpenSSH never sends, so the copy hung for ever with nothing logged (tested 23 Nov).
$remote = ":sftp,ssh='$env:SystemRoot\System32\OpenSSH\ssh.exe phoenix-spare',shell_type=unix,md5sum_command=md5sum,sha1sum_command=sha1sum,disable_hashcheck=true:archive-copy"
$sets = @(
  # the two small Excel sets first, so the big archive's time limit can never hold them back
  @{ From = 'F:\Phoenix Workforce\phoenix-workforce\xlsx'; To = 'phoenix-xlsx' },
  @{ From = 'F:\PHX backup\05-data-files'; To = 'phx-backup-data-files' },
  @{ From = 'F:\Claude Scratchpad Archive'; To = 'claude-scratchpad-archive' }
)
$failed = 0
foreach ($s in $sets) {
  if (-not (Test-Path -LiteralPath $s.From)) { Log "skipped $($s.From): not found"; continue }
  $t = [Diagnostics.Stopwatch]::StartNew()
  $a = @('copy', $s.From, "$remote/$($s.To)", '--exclude', '~$*', '--transfers', '2', '--checkers', '4', '--bwlimit', $Limit, '--max-duration', "$($Minutes)m", '--cutoff-mode', 'soft', '--stats-one-line', '--stats', '30m', '--stats-log-level', 'NOTICE', '--log-level', 'NOTICE', '--retries', '3')
  if ($DryRun) { $a += '--dry-run' }
  $ErrorActionPreference = 'Continue'   # rclone writes its notices to stderr, which Windows PowerShell would turn into an error
  $out = @(& $rclone @a 2>&1 | ForEach-Object { "$_" }) | Where-Object { "$_" -notmatch "Can't save config" }
  $code = $LASTEXITCODE; if ($code -eq 10) { $code = 0; $out += 'stopped at the time limit; the next night carries on' }   # 10 = --max-duration reached
  $summary = ($out | Select-Object -Last 1) -replace '\s+', ' '
  if ($code -eq 0) { Log ("copied {0} -> {1} in {2} s: {3}" -f $s.From, $s.To, [int]$t.Elapsed.TotalSeconds, $summary) }
  else { $failed++; Log ("FAILED {0} (rclone exit {1}): {2}" -f $s.From, $code, (($out | Select-Object -Last 3) -join ' | ')) }
}
if ($failed) { exit 1 }
Log ('archive copy finished{0}' -f $(if ($DryRun) { ' (dry run, nothing copied)' } else { '' }))
