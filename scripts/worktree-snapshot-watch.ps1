# =============================================================================
# worktree-snapshot-watch.ps1 - tell the owner on Telegram when the hourly
# worktree snapshot stops working.
#
# WHY THIS EXISTS. "Phoenix Worktree Snapshot - Hourly" copies the only existing
# copy of every uncommitted file and unpushed commit in every Phoenix worktree.
# A backup that stops working without saying so is worse than none, because it
# stops anyone looking - and this one guards work that exists NOWHERE else, so a
# silent stop plus one `git clean` is a permanent loss. Built 2026-10-04 right
# after the hourly task went live, because until then a failure showed only as a
# non-zero LastTaskResult that nobody reads.
#
# IT IS THE SAME DESIGN AS xlsx-snapshot-watch.ps1, DELIBERATELY. That one has
# run since 2026-09-09; copying its shape means one set of habits for both, and
# its hard-won decisions carry over:
#
#   IT JUDGES THE TASK, NOT THE SCRIPT'S OWN REPORT. A killed process never
#   reaches its last line, so a wrapper reporting its own exit code is blind to
#   the one case most worth hearing about. That matters more here than for xlsx:
#   the snapshot writes ONE log line, at the END, so a run killed at 1,800 MB of
#   free RAM leaves no trace in its own log at all.
#
#   THE TASK RESULT DOES CARRY A CLEAN NON-ZERO EXIT. Measured 2026-10-04 with a
#   throwaway task registered the same way these are (satoh / Interactive /
#   Limited) and read from two sources: cmd.exe exiting 7 records 0x7, node
#   exiting 3 records 0x3, node exiting 0 records 0x0, and `schtasks /query /v`
#   agrees with the CIM reading every time.
#
#   BUT A RESULT READ TOO SOON IS 0x0 WHATEVER HAPPENED. The scheduler ZEROES
#   LastTaskResult when a task starts and writes the real code as it finishes, so
#   a read taken the moment the state leaves Running can still be the zero. An
#   earlier probe the same morning reported 0x0 for an exit 3 three times over
#   and I nearly recorded that as fact - it read 2 seconds after, and registered
#   its task with no Principal, so it was not the shape that actually runs here.
#   Wait, re-read, and corroborate with schtasks before believing a 0x0.
#
#   THE LOG BRANCH IS STILL NOT REDUNDANT, for the two reasons below it: a bare
#   exit code cannot say WHAT went wrong, and a later clean run resets the result
#   while the same fault is still standing.
#
#   IT DOES NOT ALERT ON A MISSED RUN. This is a laptop; it is asleep or off for
#   most of most nights, so hourly runs legitimately do not happen and
#   StartWhenAvailable catches up on wake. An alert every morning is noise, and a
#   noisy alert gets muted. A DISABLED or DELETED task IS reported, because that
#   is a deliberate state change rather than a sleeping laptop.
#
#   TELEGRAM, NOT EMAIL. This has to work when the machine is the broken thing,
#   and a local run cannot send mail here. The chat is resolved live from the
#   same place the app resolves it, so reconnecting Telegram cannot strand it.
#
#   IT NEVER THROWS. Every failure path writes to its own log and exits 0.
#
# 🔴 THERE IS NO --test SEND, ON PURPOSE. A test send reaches the owner's phone,
# and the owner's standing rule bans test sends from a business system. The
# channel needs no fresh proof: this resolves the chat and posts through exactly
# the same credentials, the same employees -> telegram_connections lookup and the
# same Bot API call as the xlsx alert that has been delivering since 2026-09-09.
# What IS proven here is the DETECTION, with --dry-run against induced faults.
#
# 🔴 EVERY PATH AND THE TASK NAME ARE ENV-OVERRIDABLE. The xlsx original
# parameterised only its snaplog, which is why it could not simply be pointed at
# this snapshot. Exercising a branch against a FIXTURE of the real artefact is
# the only honest test - testing a copy of this logic would prove nothing about
# this file, which is the one that actually runs.
#
#   PHX_WS_TASK     the scheduled task to judge
#   PHX_WS_SNAPLOG  the snapshot's own log
#   PHX_WS_LOG      this watchdog's log
#   PHX_WS_STATE    this watchdog's de-dup state
#   PHX_WS_SUBJECT  what is being backed up, in the owner's words
# =============================================================================

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 🔴 THE SUBJECT IS A PARAMETER TOO, so ONE watcher serves every backup task on this box
# instead of a near-copy per task. Added 2026-10-04 when the ~/.claude scripts backup needed
# the same alarm: everything about watching a scheduled backup is identical, and the only
# thing that differs is the sentence describing what stopped. A second copy of this file
# would mean every future fix had to be made twice and would be made once.
#   PHX_WS_SUBJECT  what is not being copied, e.g. 'uncommitted worktree work'
#   PHX_WS_STAKE    one sentence on what a silent stop would cost
$TASK = if ($env:PHX_WS_TASK) { $env:PHX_WS_TASK } else { 'Phoenix Worktree Snapshot - Hourly' }
$SUBJECT = if ($env:PHX_WS_SUBJECT) { $env:PHX_WS_SUBJECT } else { 'uncommitted worktree work' }

# WHAT IS AT STAKE IS A PARAMETER TOO, because it is NOT the same sentence for every
# backup, and the wrong one teaches the owner the wrong urgency. The worktree snapshot
# guards work that exists NOWHERE else - one git clean and it is gone. The ~/.claude
# scripts backup guards against losing the DISK, and those scripts are still sitting on
# it meanwhile, so "the only copy there is" would be a lie there.
$STAKE = if ($env:PHX_WS_STAKE) { $env:PHX_WS_STAKE } else {
  'This is the only copy of uncommitted worktree work there is, so while it is stopped a git clean or a reset would lose that work for good.'
}

# THE WORDING IS A PARAMETER TOO (2026-10-09), so a scheduled job that is NOT a backup - the
# daily slowness sentinel - can use this same watcher without telling the owner a "backup"
# failed. Each defaults to the exact backup wording, so the two backup watchers send
# byte-for-byte what they sent before.
#   PHX_WS_HEADLINE   the message's first line
#   PHX_WS_RUN        what "the last <RUN>" names in a fault
#   PHX_WS_STOPPED    what stops when the task is missing or disabled
#   PHX_WS_UNCERTAIN  what cannot be confirmed when the task's history is unreadable
#   PHX_WS_TAIL       what follows the stake sentence
#   PHX_WS_RECOVERED  the sentence after "<HEADLINE> - RECOVERED. "
$HEADLINE = if ($env:PHX_WS_HEADLINE) { $env:PHX_WS_HEADLINE } else { 'Phoenix backup alert' }
$RUN = if ($env:PHX_WS_RUN) { $env:PHX_WS_RUN } else { "backup of $SUBJECT" }
$STOPPED = if ($env:PHX_WS_STOPPED) { $env:PHX_WS_STOPPED } else { "$SUBJECT is not being copied" }
$UNCERTAIN = if ($env:PHX_WS_UNCERTAIN) { $env:PHX_WS_UNCERTAIN } else { "whether $SUBJECT is being copied" }
$TAIL = if ($env:PHX_WS_TAIL) { $env:PHX_WS_TAIL } else { 'Nothing is lost yet - the next hourly run copies whatever it missed. Tell Claude if it keeps happening.' }
$RECOVERED = if ($env:PHX_WS_RECOVERED) { $env:PHX_WS_RECOVERED } else { "The hourly backup of $SUBJECT is running cleanly again." }
$REPO = 'F:\Phoenix Workforce\phoenix-workforce'
$SNAPLOG =if ($env:PHX_WS_SNAPLOG) { $env:PHX_WS_SNAPLOG } else { Join-Path $env:USERPROFILE '.claude\scripts\worktree-snapshot.log' }
$LOG = if ($env:PHX_WS_LOG) { $env:PHX_WS_LOG } else { Join-Path $env:USERPROFILE '.claude\scripts\worktree-snapshot-watch.log' }
$STATE = if ($env:PHX_WS_STATE) { $env:PHX_WS_STATE } else { Join-Path $env:USERPROFILE '.claude\scripts\worktree-snapshot-watch.state' }

# Re-tell after this long if the same failure is still standing, so a fault that
# is never fixed does not go quiet after one message.
$REPEAT_HOURS = 12

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
# standing admin email -> hr_id -> a CONNECTED telegram_connections row.
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
# 🔴 ALWAYS PASS -TaskPath '\'. Measured 2026-10-04, minutes after this task was
# registered: `Get-ScheduledTaskInfo -TaskName '<name>'` threw
# "The filename, directory name, or volume label syntax is incorrect"
# (HRESULT 0x8007007B, ERROR_INVALID_NAME) for a task that was perfectly
# healthy - schtasks and the same call WITH -TaskPath both read it fine, in the
# same second. It fails in the direction that looks right: with -ErrorAction
# SilentlyContinue the result is $null, `[int64]$null` is 0, and a verdict built
# on that reads "last result 0 - healthy" for a task that may have died. The
# xlsx original has the unqualified call and so has this blind spot.
#
# So: ask with the path, fall back to without, and if BOTH fail say UNREADABLE
# rather than healthy - a watchdog that cannot see is not the same as all clear.
# ---------------------------------------------------------------------------
function Get-TaskObject {
  param([string]$Name)
  $t = Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $t) { $t = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue }
  return $t
}

function Get-TaskInfo {
  param([string]$Name)
  $i = Get-ScheduledTaskInfo -TaskName $Name -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $i) { $i = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction SilentlyContinue }
  return $i
}

# ---------------------------------------------------------------------------
# The health verdict. $null when healthy, else a hashtable with a human Reason
# and a Signature used to avoid repeating the same message.
# ---------------------------------------------------------------------------
function Get-SnapshotFault {
  # NOT $task: PowerShell variable names are CASE-INSENSITIVE, so a local $task
  # would silently overwrite the $TASK constant and the message would print the
  # whole CIM object instead of the name. The xlsx original shipped that bug.
  $snapTask = Get-TaskObject $TASK
  if (-not $snapTask) {
    return @{ Reason = "The scheduled task `"$TASK`" no longer exists, so $STOPPED at all."; Signature = 'missing' }
  }
  if ($snapTask.Settings -and -not $snapTask.Settings.Enabled) {
    return @{ Reason = "The scheduled task `"$TASK`" is DISABLED, so $STOPPED."; Signature = 'disabled' }
  }

  $info = Get-TaskInfo $TASK
  if (-not $info) {
    # The task EXISTS (checked above) but its run history cannot be read. Never
    # report that as healthy - see the note above Get-TaskObject.
    return @{
      Reason    = "The scheduled task `"$TASK`" exists but Windows would not say how its last run went, so $UNCERTAIN cannot be confirmed."
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
    if ($code -eq 1) { $what = "it reported a real problem and exited 1 ($hex) - the reason is in its own log" }
    return @{
      Reason    = "The last $RUN did not finish cleanly: $what. Last run $lastRun."
      Signature = 'result:' + $hex + ':' + $lastRun
    }
  }

  # The snapshot writes exactly ONE line per run, at the end: "[iso] OK {...}" or
  # "[iso] FAIL {...} PROBLEMS: ...". A FAIL line names WHAT went wrong, which the
  # task's bare exit code cannot, so it is read even though exit 1 would also be
  # caught above - the task result can be reset by a later clean run while the
  # same fault is still standing.
  if (Test-Path -LiteralPath $SNAPLOG) {
    $lines = @(Get-Content -LiteralPath $SNAPLOG -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ -match '\S' })
    # READ THE LAST ENTRY, NOT THE LAST LINE. The worktree snapshot writes one line
    # per run, but the ~/.claude scripts backup's FAIL carries git's own multi-line
    # error underneath it - so the last LINE of a failed run is "error: failed to
    # push some refs", which matches nothing here and read as HEALTHY (measured
    # 2026-10-04 against claude-scripts-backup.log's real 05:28:42 failure). An
    # entry is a line that OPENS with "[<timestamp>] "; anything else is a
    # continuation of the one above it.
    $last = $null
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      if ($lines[$i] -match '^\[(\S+)\]\s+\S') { $last = $lines[$i]; break }
    }
    if ($last) {
      if ($last -match '^\[(\S+)\]\s+FAIL') {
        $detail = $last
        if ($last -match 'PROBLEMS:\s*(.+)$') { $detail = $Matches[1] }
        return @{
          Reason    = "The last $RUN ran but reported a problem: $detail"
          Signature = 'faillog:' + $last
        }
      }
    }
  }

  return $null
}

# ---------------------------------------------------------------------------
try {
  $fault = Get-SnapshotFault

  # --dry-run prints the verdict and sends nothing, so detection can be exercised
  # against a real induced fault without putting an alarming message in front of
  # the owner. Also the right first command when diagnosing this later.
  if ($args -contains '--dry-run') {
    if ($fault) { 'FAULT: ' + $fault.Reason; 'signature: ' + $fault.Signature } else { 'healthy - nothing would be sent' }
    exit 0
  }

  if (-not $fault) {
    if (Test-Path -LiteralPath $STATE) {
      Remove-Item -LiteralPath $STATE -Force -ErrorAction SilentlyContinue
      Send-OwnerTelegram ($HEADLINE + ' - RECOVERED. ' + $RECOVERED) | Out-Null
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

  $message = $HEADLINE + [char]10 + [char]10 + $fault.Reason + [char]10 + [char]10 +
    $STAKE + ' ' + $TAIL
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
