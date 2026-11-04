# =============================================================================
# xlsx-snapshot-watch.ps1 - tell the owner on Telegram when the xlsx snapshot fails.
#
# WHY THIS EXISTS. On 2026-09-09 the machine hit its physical memory floor and
# two snapshot runs were killed mid-flight (LastTaskResult 0xC000013A, a
# Ctrl+C-class kill). One died before it could write even its first log line.
# Nothing said so. The backup of the ~180 spreadsheets that git does not hold
# simply did not happen for those hours, and the only record was a log nobody
# reads. A backup that stops working without saying so is worse than none,
# because it stops anyone looking.
#
# IT JUDGES THE TASK, NOT THE SCRIPT'S OWN REPORT. The obvious build appends an
# alert to the end of xlsx-snapshot.cmd, on a non-zero errorlevel. That build
# cannot see the failure that actually happened here: a killed process never
# reaches its last line, so the one case most worth hearing about is the exact
# case it is blind to. Reading the scheduled task's own recorded result catches
# a kill, a crash and a clean non-zero exit alike - re-measured 2026-10-04 from
# two sources: cmd.exe exiting 7 records 0x7 and node exiting 3 records 0x3.
#
# WHAT IS NOT SAFE IS READING THAT RESULT TOO SOON. The scheduler zeroes it when
# the task starts and writes the real code as it finishes, so a read taken as the
# state leaves Running can still be 0x0. A probe that got 0x0 for an exit 3 three
# times over on 2026-10-04 was reading 2 seconds after, and had registered its
# task with no Principal. This watcher reads a result left behind by a run that
# finished long ago, so it is not exposed - but do not repeat that probe shape.
#
# IT DELIBERATELY DOES NOT ALERT ON A MISSED RUN. This is a laptop. It is asleep
# or off for most of most nights, so the hourly runs legitimately do not happen
# and StartWhenAvailable catches up on wake. An alert that fires every morning is
# noise, and a noisy alert gets muted, which costs more than the alert was ever
# worth. A DISABLED or DELETED task is still reported, because that is a
# deliberate state change rather than a sleeping laptop.
#
# TELEGRAM, NOT EMAIL. This has to work when the machine or the app is the thing
# that is broken, and a local run cannot send mail here anyway. The chat is
# resolved live from the same place the app resolves it, so reconnecting Telegram
# does not silently break this.
#
# IT NEVER THROWS. A watchdog that dies on an unexpected shape is a watchdog that
# is not watching. Every failure path writes to its own log and exits 0.
# =============================================================================

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$TASK  = 'Phoenix xlsx Snapshot - Hourly'
$REPO  = 'F:\Phoenix Workforce\phoenix-workforce'
# Overridable so the mid-run-death branch can be exercised against a fixture.
# Testing a COPY of this logic would prove nothing about this file - the defect
# that matters is always in the artefact that actually runs. Unset, it is real.
$SNAPLOG = if ($env:PHX_XS_SNAPLOG) { $env:PHX_XS_SNAPLOG } else { Join-Path $env:USERPROFILE '.claude\scripts\xlsx-snapshot.log' }
$LOG   = Join-Path $env:USERPROFILE '.claude\scripts\xlsx-snapshot-watch.log'
$STATE = Join-Path $env:USERPROFILE '.claude\scripts\xlsx-snapshot-watch.state'
# Re-tell after this long if the same failure is still standing, so a fault that
# is never fixed does not go quiet after one message.
$REPEAT_HOURS = 12
# An in-flight run has a header and no result yet. Only call that a failure once
# it is older than this; a healthy run takes seconds, and ~4 minutes at worst.
$INFLIGHT_GRACE_MIN = 30

function Write-WatchLog {
  param([string]$m)
  try {
    Add-Content -LiteralPath $LOG -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $m) -Encoding utf8
  } catch { }
}

# ---------------------------------------------------------------------------
# .env.local is the machine's own credential store. Read, never printed, never
# copied anywhere: the values stay inside this process.
# ---------------------------------------------------------------------------
function Read-EnvValue {
  param([string]$Key)
  $path = Join-Path $REPO '.env.local'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  foreach ($line in (Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)) {
    if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
      $v = $Matches[1].Trim()
      if ($v.StartsWith('"') -and $v.EndsWith('"') -and $v.Length -ge 2) { $v = $v.Substring(1, $v.Length - 2) }
      if ($v.StartsWith("'") -and $v.EndsWith("'") -and $v.Length -ge 2) { $v = $v.Substring(1, $v.Length - 2) }
      return $v
    }
  }
  return $null
}

# Resolve the owner's chat the same way admin-telegram-mirror.ts does: the
# standing admin email -> hr_id -> a CONNECTED telegram_connections row. Kept in
# step with the app deliberately, so reconnecting Telegram cannot strand this.
function Get-OwnerChatIds {
  $url = Read-EnvValue 'NEXT_PUBLIC_SUPABASE_URL'
  $key = Read-EnvValue 'SUPABASE_SERVICE_ROLE_KEY'
  if (-not $url -or -not $key) { Write-WatchLog 'FAILED - no Supabase credentials in .env.local'; return @() }
  # Supabase refuses the sb_secret key from anything that looks like a browser, and
  # Windows PowerShell 5.1 sends "Mozilla/5.0 ..." by default: every chat lookup
  # answered 401 from about 8 Oct to 27 Oct 2026 and no alarm reached Telegram.
  $SUPABASE_UA = 'phoenix-watch/1.0'
  $headers = @{ apikey = $key; Authorization = 'Bearer ' + $key }
  try {
    $emp = Invoke-RestMethod -Method Get -Headers $headers -TimeoutSec 30 -UserAgent $SUPABASE_UA `
      -Uri ($url.TrimEnd('/') + '/rest/v1/employees?select=hr_id&work_email=ilike.omar.anwar@satopharma.com&limit=1')
    if (-not $emp -or $emp.Count -eq 0) { Write-WatchLog 'FAILED - the standing admin email matched no employee'; return @() }
    $hrId = $emp[0].hr_id
    $conn = Invoke-RestMethod -Method Get -Headers $headers -TimeoutSec 30 -UserAgent $SUPABASE_UA `
      -Uri ($url.TrimEnd('/') + '/rest/v1/telegram_connections?select=telegram_chat_id&status=eq.connected&hr_id=ilike.' + [uri]::EscapeDataString($hrId))
    $ids = @()
    foreach ($row in $conn) { if ($row.telegram_chat_id) { $ids += [string]$row.telegram_chat_id } }
    if ($ids.Count -eq 0) { Write-WatchLog 'FAILED - the owner has no CONNECTED telegram_connections row' }
    return $ids
  } catch {
    Write-WatchLog ('FAILED - could not resolve the chat: ' + $_.Exception.Message)
    return @()
  }
}

function Send-OwnerTelegram {
  param([string]$Text)
  $token = Read-EnvValue 'TELEGRAM_BOT_TOKEN'
  if (-not $token) { Write-WatchLog 'FAILED - TELEGRAM_BOT_TOKEN missing'; return $false }
  $chatIds = Get-OwnerChatIds
  if ($chatIds.Count -eq 0) { return $false }
  $sent = $false
  foreach ($chatId in $chatIds) {
    try {
      Invoke-RestMethod -Method Post -TimeoutSec 30 `
        -Uri ('https://api.telegram.org/bot' + $token + '/sendMessage') `
        -Body @{ chat_id = $chatId; text = $Text; disable_web_page_preview = 'true' } | Out-Null
      $sent = $true
    } catch {
      Write-WatchLog ('FAILED - Telegram send: ' + $_.Exception.Message)
    }
  }
  return $sent
}

# ---------------------------------------------------------------------------
# The health verdict. Returns $null when healthy, else a hashtable with a
# human Reason and a Signature used to avoid repeating the same message.
# ---------------------------------------------------------------------------
function Get-SnapshotFault {
  # NOT $task: PowerShell variable names are CASE-INSENSITIVE, so a local $task
  # silently overwrites the $TASK constant above, and the alert then prints the
  # whole CIM object instead of the task's name. Measured, not theorised - the
  # first version of this shipped that message.
  # 🔴 -TaskPath '\' IS NOT OPTIONAL. Measured 2026-10-04 on the sibling
  # worktree-snapshot-watch.ps1: the unqualified call threw ERROR_INVALID_NAME
  # (0x8007007B, "The filename, directory name, or volume label syntax is
  # incorrect") for a task that was perfectly healthy, while schtasks and the
  # same call WITH the path both read it in the same second. With
  # -ErrorAction SilentlyContinue that becomes $null, `[int64]$null` is 0, and a
  # dead backup reads as "last result 0 - healthy". Ask with the path, fall back
  # to without, and never treat an unreadable task as all clear.
  $snapTask = Get-ScheduledTask -TaskName $TASK -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $snapTask) { $snapTask = Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue }
  if (-not $snapTask) {
    return @{ Reason = "The scheduled task `"$TASK`" no longer exists, so the spreadsheets are not being backed up at all."; Signature = 'missing' }
  }
  if ($snapTask.Settings -and -not $snapTask.Settings.Enabled) {
    return @{ Reason = "The scheduled task `"$TASK`" is DISABLED, so the spreadsheets are not being backed up."; Signature = 'disabled' }
  }

  $info = Get-ScheduledTaskInfo -TaskName $TASK -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $info) { $info = Get-ScheduledTaskInfo -TaskName $TASK -ErrorAction SilentlyContinue }
  if (-not $info) {
    # The task EXISTS (checked above) but its run history will not read, so
    # whether the backup ran is UNKNOWN - which is not the same as healthy.
    return @{
      Reason    = "The scheduled task `"$TASK`" exists but Windows would not say how its last run went, so whether the spreadsheets are being backed up cannot be confirmed."
      Signature = 'unreadable'
    }
  }

  $code = [int64]$info.LastTaskResult
  $lastRun = $info.LastRunTime
  # 0x41301 SCHED_S_TASK_RUNNING and 0x41303 "has never run" are not failures.
  if ($code -ne 0 -and $code -ne 0x41301 -and $code -ne 0x41303) {
    $hex = '0x' + ('{0:X}' -f $code)
    $what = "exit code $hex"
    if ($code -eq 0xC000013A -or $code -eq -1073741510) { $what = "it was KILLED mid-run ($hex) - usually the machine running out of memory" }
    if ($code -eq 0x41306 -or $code -eq 267014) { $what = "it was STOPPED before finishing ($hex)" }
    return @{
      Reason    = "The last spreadsheet backup did not finish: $what. Last run $lastRun."
      Signature = 'result:' + $hex + ':' + $lastRun
    }
  }

  # A run that wrote its header and never wrote a result died mid-flight. This is
  # the case a self-reporting wrapper inside the script can never see.
  if (Test-Path -LiteralPath $SNAPLOG) {
    $lines = Get-Content -LiteralPath $SNAPLOG -Encoding UTF8 -ErrorAction SilentlyContinue
    $lastHeaderIdx = -1
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      if ($lines[$i] -like '===== *') { $lastHeaderIdx = $i; break }
    }
    if ($lastHeaderIdx -ge 0) {
      $completed = $false
      for ($i = $lastHeaderIdx; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -like 'exit=*') { $completed = $true; break }
      }
      $header = $lines[$lastHeaderIdx]
      if (-not $completed) {
        $stamp = $null
        if ($header -match '=====\s+\w{3}\s+(\S+)\s+(\S+)\s+=====') {
          try { $stamp = [datetime]::Parse($Matches[1] + ' ' + $Matches[2]) } catch { $stamp = $null }
        }
        # Only a fault once the grace window has passed - otherwise a run that is
        # simply still going gets reported as a failure every hour.
        if ($null -eq $stamp -or $stamp -lt (Get-Date).AddMinutes(-$INFLIGHT_GRACE_MIN)) {
          return @{
            Reason    = "A spreadsheet backup started and never finished - it died mid-run. Started $header"
            Signature = 'incomplete:' + $header
          }
        }
      }
    }
  }

  return $null
}

# ---------------------------------------------------------------------------
try {
  if ($args -contains '--test') {
    $ok = Send-OwnerTelegram ("Phoenix backup alert - TEST ONLY, nothing is wrong." + [char]10 + [char]10 +
      "This is the new alert for the hourly spreadsheet backup, sent by hand on 2026-09-09 to prove the channel works. " +
      "From now on you will only hear from it when a backup run actually fails.")
    Write-WatchLog ('test send: ' + $ok)
    if ($ok) { 'test message sent' } else { 'test send FAILED - see ' + $LOG }
    exit 0
  }

  $fault = Get-SnapshotFault

  # --dry-run prints the verdict and sends nothing, so the detection can be
  # exercised against a real induced fault without putting an alarming message
  # in front of the owner. Also the right first command when diagnosing later.
  if ($args -contains '--dry-run') {
    if ($fault) { 'FAULT: ' + $fault.Reason; 'signature: ' + $fault.Signature } else { 'healthy - nothing would be sent' }
    exit 0
  }

  if (-not $fault) {
    if (Test-Path -LiteralPath $STATE) {
      Remove-Item -LiteralPath $STATE -Force -ErrorAction SilentlyContinue
      $recovered = 'Phoenix backup alert - RECOVERED. The hourly spreadsheet backup is running cleanly again.'
      Send-OwnerTelegram $recovered | Out-Null
      Write-WatchLog 'healthy again - recovery sent'
    } else {
      Write-WatchLog 'healthy'
    }
    exit 0
  }

  # Same fault already reported, and not yet time to repeat it.
  $previous = $null
  if (Test-Path -LiteralPath $STATE) { $previous = Get-Content -LiteralPath $STATE -Raw -Encoding UTF8 -ErrorAction SilentlyContinue }
  if ($previous) {
    $parts = $previous -split '\|', 2
    if ($parts.Count -eq 2 -and $parts[0] -eq $fault.Signature) {
      $when = $null
      try { $when = [datetime]::Parse($parts[1]) } catch { $when = $null }
      if ($when -and $when -gt (Get-Date).AddHours(-$REPEAT_HOURS)) {
        Write-WatchLog ('fault still standing, already reported: ' + $fault.Signature)
        exit 0
      }
    }
  }

  $message = 'Phoenix backup alert' + [char]10 + [char]10 + $fault.Reason + [char]10 + [char]10 +
    'The spreadsheets in xlsx/ are the ones git does not hold, so a missed backup is the only copy at risk. ' +
    'Nothing is lost yet - the next hourly run copies whatever it missed. Tell Claude if it keeps happening.'
  $sent = Send-OwnerTelegram $message
  Write-WatchLog ('FAULT: ' + $fault.Reason + ' | telegram sent: ' + $sent)
  if ($sent) {
    Set-Content -LiteralPath $STATE -Value ($fault.Signature + '|' + (Get-Date).ToString('o')) -Encoding utf8
  }
  exit 0
} catch {
  Write-WatchLog ('watchdog itself failed: ' + $_.Exception.Message)
  exit 0
}
