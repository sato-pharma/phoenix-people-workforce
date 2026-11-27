# =============================================================================
# xlsx-tripwire.ps1 - name the process that deletes files out of xlsx/.
#
# WHY THIS EXISTS. On 2026-09-05 every *.pdf under xlsx/ was hard-unlinked from
# every checkout on this machine, twice, nineteen minutes apart, each sweep well
# under half a second across eight folders. Five were tracked and came back from
# git. One untracked one, b2-probe-2-page-a4.pdf, is gone for good. The cause was
# never found: not Defender, not the Recycle Bin, not a scheduled task, not any
# repo script, not .gitignore. Every artefact it left was a FILE artefact, and a
# file cannot say who removed it.
#
# So this watches instead of reading the wreckage afterwards. FileSystemWatcher
# fires within milliseconds, and the sweep needed ~320 ms to finish its remaining
# folders - so the culprit is very probably STILL RUNNING when we capture. That
# window is the whole design. The capture takes every process WITH ITS COMMAND
# LINE, which is what actually distinguishes one `node something.mjs` from the
# thirty-odd node processes normally live on this machine.
#
# WHY NOT -Action. The obvious build registers a scriptblock with
# Register-ObjectEvent -Action and parks the main thread on Start-Sleep. Measured
# here 2026-09-05: that build fired 60 SECONDS after the deletion, not on it -
# the action does not preempt Start-Sleep, so it ran when the sleep ended. Sixty
# seconds destroys the entire value of the capture, because the one thing worth
# catching is a process that lives about a third of a second. Wait-Event returns
# the moment an event queues, so the drain below is millisecond-latency.
#
# A second hazard on that path, also measured: when an -Action scriptblock
# throws, the subscriber's job state goes to Failed and nothing is written or
# raised. Draining on the main thread makes an exception visible and logged.
#
# IT WATCHES ALL FILES, not just *.pdf. The sweep was pdf-only, but that is an
# observation about two events, not a law, and a tripwire that can only catch the
# thing you already know is not a tripwire.
#
# IT ALSO RESTORES. Tracked files come back from git automatically, so a repeat
# costs nothing while we wait for one. It only ever ADDS files back; it never
# deletes, and it never touches an untracked file.
#
# WHAT IT IS NOT. This cannot PROVE who did it the way a SACL plus auditpol
# event 4663 can. That needs a change to the machine's security audit policy and
# is the owner's call, not this script's. This is the no-admin approximation:
# strong circumstantial evidence captured at the instant, rather than a receipt.
# =============================================================================

$ErrorActionPreference = 'Continue'
# Overridable so the script can be exercised against a throwaway repo. Testing a
# COPY of this logic would prove nothing about this file - the defect that matters
# is always in the artefact that actually runs. Unset, these are the real paths.
$LOG   = if ($env:PHX_TW_LOG)   { $env:PHX_TW_LOG }   else { Join-Path $env:USERPROFILE '.claude\scripts\xlsx-tripwire.log' }
$ALIVE = if ($env:PHX_TW_ALIVE) { $env:PHX_TW_ALIVE } else { Join-Path $env:USERPROFILE '.claude\scripts\xlsx-tripwire.alive' }
$REPO  = if ($env:PHX_TW_REPO)  { $env:PHX_TW_REPO }  else { 'F:\Phoenix Workforce\phoenix-workforce' }
$DUMPS = if ($env:PHX_TW_DUMPS) { $env:PHX_TW_DUMPS } else { Join-Path $env:USERPROFILE '.claude\scripts' }

# The log is CAPPED. Unbounded, it reached 17 MB by 2026-09-17 and was copied into
# every backup of this folder. Past 5 MB it is renamed to <log>.1 (replacing the older
# rotated copy, so exactly one survives) and a fresh file starts. A capture is never
# split across the two files: rotation is skipped while one is being written and runs
# at the start of the next capture or idle tick instead.
$LOG_CAP_BYTES = if ($env:PHX_TW_LOG_CAP) { [int64]$env:PHX_TW_LOG_CAP } else { 5MB }
$script:inCapture = $false
function Invoke-TwRotate {
  try {
    $fi = New-Object System.IO.FileInfo $LOG
    if (-not $fi.Exists -or $fi.Length -le $LOG_CAP_BYTES) { return }
    $old = "$LOG.1"
    if (Test-Path -LiteralPath $old) { [System.IO.File]::Delete($old) }
    [System.IO.File]::Move($LOG, $old)
    Add-Content -LiteralPath $LOG -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff') + "  ### log rotated at $([math]::Round($fi.Length / 1MB, 1)) MB - the previous part is $old (one rotated copy is kept)") -Encoding utf8
  } catch {}
}

function Write-TwLog {
  param([string]$m)
  if (-not $script:inCapture) { Invoke-TwRotate }
  Add-Content -LiteralPath $LOG -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff') + '  ' + $m) -Encoding utf8
}

# A captured command line can carry a live credential. On 2026-09-17 this log held a
# production database URL, password included, copied out of another process's command
# line; it was masked by hand. Everything a capture writes - the log lines AND the
# full process dump - now goes through this first. It masks the VALUE and keeps the
# name, so a reader can still see that a credential was passed and how.
function Protect-TwSecrets {
  param([string]$s)
  if ([string]::IsNullOrEmpty($s)) { return $s }
  # scheme://user:PASSWORD@host - postgres, redis, amqp, https basic auth alike.
  $s = $s -replace '(?i)\b([a-z][a-z0-9+.-]*://[^/\s:@''"]+:)[^@\s''"/]+@', '$1***@'
  # Authorization headers: any Bearer value, and Basic / token after "Authorization:".
  $s = $s -replace '(?i)\b(Bearer\s+)(?!\*\*\*)[A-Za-z0-9._~+/=-]{8,}', '$1***'
  $s = $s -replace '(?i)(Authorization:\s*(?:Basic|token)\s+)(?!\*\*\*)[A-Za-z0-9._~+/=-]{8,}', '$1***'
  # Well-known token shapes, wherever they appear: JWTs (Supabase keys), Supabase and
  # GitHub personal tokens, OpenAI/Anthropic keys, Slack, AWS access keys, Telegram bots.
  $s = $s -replace '\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}', 'eyJ***'
  $s = $s -replace '\b(sbp|sbp_v0|ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}', '$1_***'
  $s = $s -replace '\b(sk|rk|pk)-(ant-)?[A-Za-z0-9_-]{16,}', '$1-$2***'
  $s = $s -replace '\bxox[abprs]-[A-Za-z0-9-]{10,}', 'xox***'
  $s = $s -replace '\bAKIA[0-9A-Z]{16}\b', 'AKIA***'
  $s = $s -replace '\b(\d{8,10}):[A-Za-z0-9_-]{30,}\b', '$1:***'
  # NAME=value / NAME: value / "name": "value" where the name says it is a secret.
  $s = $s -replace '(?i)\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|service[_-]?role(?:[_-]?key)?|client[_-]?secret|credentials?|auth[_-]?key|database[_-]?url|db[_-]?url|connection[_-]?string|dsn|cookie)[A-Za-z0-9_.-]*)((?:\\?["''])?\s*[:=]\s*(?:\\?["''])?)(?!\*\*\*)[^\s"''\\&|;,)}]+', '$1$2***'
  # --password value / --token=value style flags.
  $s = $s -replace '(?i)(--?(?:password|passwd|pass|token|secret|api-?key|access-?token|auth-?token|db-?url|database-?url|connection-?string)(?:=|\s+))(?!\*\*\*)[^\s"'']+', '$1***'
  return $s
}

# A captured command line can itself be MULTI-LINE - a shell invoked with an
# embedded script is the normal case on this machine. Written raw, one process
# sprays dozens of un-timestamped lines into the log and every line-oriented read
# of it breaks. Worse, it can contain the log's own marker text: a capture of the
# process that was grepping this file for "TRIPWIRE FIRED" put that exact phrase
# into the log as data, so a later grep counts fires that never happened.
# Flattened to one line, nothing is lost and the marker only ever appears on a
# line that starts with a timestamp.
# It also neutralises the log's own marker inside captured data. Flattening alone
# is not enough: a captured command line is written THROUGH Write-TwLog, so it
# gets a timestamp prefix too, and a grep for the marker still counts it as a
# fire. That is not hypothetical - it happened during this script's own self-test
# and made the measured latency read 408 ms instead of 63. After this, the marker
# appears in the log only where the tripwire actually put it.
function Format-TwCmd {
  param([string]$c)
  if ([string]::IsNullOrEmpty($c)) { return '(no command line)' }
  $flat = Protect-TwSecrets ($c -replace '[\r\n\t]+', ' ')
  return ($flat -replace 'TRIPWIRE FIRED', 'TRIPWIRE-FIRED[text quoted from a command line, not a fire]')
}

# --- the capture -------------------------------------------------------------
function Invoke-TwCapture {
  param([string]$what)

  # Stage one is Get-Process: ~20 ms, no command lines. Stage two is CIM: ~300 ms,
  # WITH command lines. Anything present in stage one and gone by stage two exited
  # inside that gap - for a sweep this short that is the single strongest lead, and
  # it would be invisible to a capture that only ran the slow call.
  $fast = @{}
  try { Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $fast[$_.Id] = $_.ProcessName } } catch {}

  Invoke-TwRotate
  $script:inCapture = $true
  $script:incidents++
  Write-TwLog ''
  Write-TwLog '=============================================================='
  Write-TwLog "TRIPWIRE FIRED: $what"
  Write-TwLog "  processes alive at the instant (fast pass): $($fast.Count)"

  try {
    $procs = @(Get-CimInstance Win32_Process -ErrorAction Stop |
      Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine)
    $slow = @{}
    foreach ($p in $procs) { $slow[[int]$p.ProcessId] = $true }

    $vanished = @($fast.Keys | Where-Object { -not $slow.ContainsKey($_) })
    Write-TwLog "  --- EXITED between the two passes ($($vanished.Count)) - short-lived, the strongest lead ---"
    foreach ($id in $vanished) {
      Write-TwLog ("    [{0}] {1}   (gone before its command line could be read)" -f $id, $fast[$id])
    }

    $now = Get-Date
    $fresh = @($procs | Where-Object { $_.CreationDate -and ($now - $_.CreationDate).TotalSeconds -lt 120 })
    Write-TwLog "  --- started within the last 120 s ($($fresh.Count)) ---"
    foreach ($p in ($fresh | Sort-Object CreationDate)) {
      Write-TwLog ("    [{0}] {1}  parent={2}  started={3}" -f $p.ProcessId, $p.Name, $p.ParentProcessId, $p.CreationDate)
      Write-TwLog ("        {0}" -f (Format-TwCmd $p.CommandLine))
    }

    # The deleter had to name the path somehow, so anything whose command line
    # mentions the repo, the drive or a data extension is worth reading in full.
    $rx = 'xlsx|\.pdf|Phoenix Workforce|F:\\|phoenix-workforce'
    $rel = @($procs | Where-Object { $_.CommandLine -and $_.CommandLine -match $rx })
    Write-TwLog "  --- command line mentions the repo, F:\ or a data file ($($rel.Count)) ---"
    foreach ($p in $rel) {
      Write-TwLog ("    [{0}] {1}  started={2}" -f $p.ProcessId, $p.Name, $p.CreationDate)
      Write-TwLog ("        {0}" -f (Format-TwCmd $p.CommandLine))
    }

    $dump = Join-Path $DUMPS ("xlsx-tripwire-procs-{0}.txt" -f $now.ToString('yyyyMMdd-HHmmss-fff'))
    # The dump holds every command line too, so it is masked exactly like the log.
    $procs | Sort-Object CreationDate |
      Select-Object ProcessId, ParentProcessId, Name, CreationDate, @{ n = 'CommandLine'; e = { Protect-TwSecrets $_.CommandLine } } |
      Format-List | Out-File -LiteralPath $dump -Encoding utf8
    Write-TwLog "  full process dump: $dump"
    $keep = @(Get-ChildItem -LiteralPath $DUMPS -Filter 'xlsx-tripwire-procs-*.txt' -EA 0 |
      Sort-Object LastWriteTime -Descending | Select-Object -Skip 20)
    foreach ($stale in $keep) { [System.IO.File]::Delete($stale.FullName) }
  } catch {
    Write-TwLog "  PROCESS CAPTURE FAILED: $($_.Exception.Message)"
  }

  # --- restore, so a repeat costs nothing ------------------------------------
  # It restores ONLY a tracked file that is actually missing, by its own path. The old
  # build ran `git checkout -- xlsx/` on the whole folder, which also throws away an
  # uncommitted EDIT to any tracked sheet in it, and it ran in every worktree git
  # listed - including one still being checked out (2026-09-17 14:59, it "restored" six
  # files into a worktree that was mid-creation) and one being torn down. Now a
  # worktree is skipped unless it is in the watched set, still has its .git, and has no
  # index.lock (a checkout or other git write in progress); each path is re-tested on
  # disk just before the restore.
  try {
    $restored = 0
    foreach ($line in (& git -C $REPO worktree list --porcelain 2>$null)) {
      if ($line -notlike 'worktree *') { continue }
      $wt = $line.Substring(9)
      $wtWin = $wt -replace '/', '\'
      if (-not ($folders -contains (Join-Path $wtWin 'xlsx'))) { continue }
      if (-not (Test-Path -LiteralPath (Join-Path $wtWin '.git'))) { continue }
      $gitDir = (& git -C $wt rev-parse --absolute-git-dir 2>$null | Select-Object -First 1)
      if ($gitDir -and (Test-Path -LiteralPath (Join-Path $gitDir 'index.lock'))) {
        Write-TwLog "  restore skipped in $wt - index.lock present, a git write is in progress"
        continue
      }
      $missing = @(& git -C $wt -c core.quotepath=off ls-files --deleted -- xlsx/ 2>$null |
        Where-Object { $_ -and -not (Test-Path -LiteralPath (Join-Path $wtWin ($_ -replace '/', '\'))) })
      foreach ($rel in $missing) {
        & git -C $wt checkout -- ":(literal)$rel" 2>$null
        if (Test-Path -LiteralPath (Join-Path $wtWin ($rel -replace '/', '\'))) {
          Write-TwLog "  RESTORED $rel in $wt"
          $restored++
        } else {
          Write-TwLog "  RESTORE FAILED for $rel in $wt"
        }
      }
    }
    if ($restored -eq 0) {
      Write-TwLog '  nothing tracked was missing - either an UNTRACKED file (NOT recoverable) or a self-test'
    }
  } catch {
    Write-TwLog "  RESTORE FAILED: $($_.Exception.Message)"
  }
  Write-TwLog '=============================================================='
  $script:inCapture = $false
}

# --- routine removals are not incidents ---------------------------------------
# Measured over 2026-09-05..17: all 641 captures were routine. 595 were a worktree
# being REMOVED (git deletes the whole folder, so its xlsx/ goes too), 43 were Office's
# own "~$name.xlsx" lock file vanishing when a sheet was closed, 4 were Excel's
# save-time temp file. Each wrote a multi-megabyte capture and buried the log.
#
# A worktree removal is recognised by its .git entry being ALREADY GONE when the
# xlsx/ event arrives: git, Node and Explorer all delete in directory order, and
# ".git" sorts before "xlsx", so a folder being torn down has lost .git first. The
# 2026-09-05 sweep this script exists for left every checkout - and its .git - in
# place, so it can never be mistaken for a removal. Such an event is logged as ONE
# routine line per worktree, with no capture and no restore (restoring into a folder
# being deleted is what leaves a husk behind).
$script:routineSeen = @{}
$script:incidents = 0
$script:routineWt = 0
$script:routineLock = 0
function Test-TwRoutine {
  param([string]$fullPath, [string]$otherPath)
  $name = Split-Path -Leaf $fullPath
  $other = if ($otherPath) { Split-Path -Leaf $otherPath } else { '' }
  # A rename is routine when EITHER side is Excel's temp name: Excel saves by writing
  # a temp file and swapping names with the real one.
  if ($other -match '^[0-9A-F]{8}(\.tmp)?$') { $name = $other }
  if ($name -like '~$*') {
    $script:routineLock++
    Write-TwLog "  routine - Office lock file removed when a sheet was closed: $fullPath"
    return $true
  }
  if ($name -match '^[0-9A-F]{8}(\.tmp)?$') {
    $script:routineLock++
    Write-TwLog "  routine - Excel save-time temp file: $fullPath"
    return $true
  }
  $wt = Split-Path -Parent (Split-Path -Parent $fullPath)
  if (-not (Test-Path -LiteralPath (Join-Path $wt '.git'))) {
    $now = Get-Date
    foreach ($k in @($script:routineSeen.Keys)) { if (($now - $script:routineSeen[$k]).TotalMinutes -gt 15) { $script:routineSeen.Remove($k) } }
    if (-not $script:routineSeen.ContainsKey($wt)) {
      $script:routineWt++
      Write-TwLog "### routine - worktree being removed (its .git is already gone): $wt - not an incident, no capture, no restore"
    }
    $script:routineSeen[$wt] = $now
    return $true
  }
  return $false
}

# --- refuse to be the second watcher ----------------------------------------
# Two tripwires means two captures per event, interleaved into one log, and a
# reader who cannot tell a duplicate from a second sweep. The heartbeat is the
# test: fresh, and naming a process that is actually alive.
if (Test-Path -LiteralPath $ALIVE) {
  $beat = (Get-Content -LiteralPath $ALIVE -Raw -Encoding UTF8).Trim()
  if ($beat -match '^(\S+ \S+) pid=(\d+)') {
    $when = [datetime]::MinValue
    $ok = [datetime]::TryParse($Matches[1], [ref]$when)
    $other = Get-Process -Id ([int]$Matches[2]) -ErrorAction SilentlyContinue
    if ($ok -and $other -and ((Get-Date) - $when).TotalSeconds -lt 90) {
      # Exit 0, not an error code. This script is started every 10 minutes by the
      # scheduled task as a resurrect-if-dead heartbeat, so "a healthy watcher is
      # already running" is the SUCCESS case - the goal state is satisfied. Reporting
      # a failure code here would paint the task history permanently red and train
      # whoever reads it to ignore the one run that actually failed.
      Write-TwLog "already watching - pid $($Matches[2]), heartbeat $($Matches[1]). Not arming a second."
      exit 0
    }
  }
}

# --- which folders to watch --------------------------------------------------
# Re-read live, never cached. Worktrees are created and retired here constantly -
# that is the normal working pattern, not an exception - so a set captured once at
# arming goes stale within the hour. Measured 2026-09-05: two worktrees were retired
# and a third created while this was running, leaving the tripwire watching two
# folders that no longer existed and BLIND to one that did. A sensor that quietly
# stops covering new work is the failure this whole script exists to avoid.
function Get-TwFolders {
  $out = @()
  foreach ($line in (& git -C $REPO worktree list --porcelain 2>$null)) {
    if ($line -like 'worktree *') {
      $x = Join-Path $line.Substring(9) 'xlsx'
      if (Test-Path -LiteralPath $x) { $out += $x }
    }
  }
  return ,$out
}

$folders = Get-TwFolders
if ($folders.Count -eq 0) {
  Write-TwLog 'REFUSED - found no xlsx folder to watch. Wrong repo path?'
  exit 2
}

Write-TwLog ''
Write-TwLog "### tripwire armed on $($folders.Count) folder(s), pid $PID"
# Whoever reads this log will read it at the worst possible moment, probably at 4am,
# after finding files missing. Tell them how to read it, in the log itself.
Write-TwLog '### HOW TO READ THIS LOG'
Write-TwLog '###   A real event is a line reading "<timestamp>  TRIPWIRE FIRED:". Nothing else is one.'
Write-TwLog '###   Indented lines under it are CAPTURED DATA - other processes command lines, quoted.'
Write-TwLog '###   Any marker text inside captured data is rewritten TRIPWIRE-FIRED[...] so it cannot'
Write-TwLog '###   be mistaken for an event.'
Write-TwLog '###   "EXITED between the two passes" is the strongest lead: short-lived processes that'
Write-TwLog '###   died before their command line could be read.'
Write-TwLog '###   A QUIET log only means "nothing was deleted" if the tripwire was RUNNING. A "### heartbeat"'
Write-TwLog '###   line is written every hour; a stretch with none means it was NOT running. The file'
Write-TwLog '###   xlsx-tripwire.alive is rewritten at least every 30 s and shows whether it runs NOW.'
Write-TwLog '###   "routine -" lines are a worktree being removed or an Office lock/temp file: not incidents.'
Write-TwLog '###   Credentials in captured command lines are masked (***). The log is capped at 5 MB; the'
Write-TwLog '###   previous part is xlsx-tripwire.log.1.'
Write-TwLog '### the watched set is RE-READ every 30 s, so a worktree added or retired is picked up'
Write-TwLog '### on its own - look for a "### re-armed" line rather than assuming this list still holds.'

$script:watchers = @()
function Set-TwWatchers {
  param([string[]]$paths)
  foreach ($s in @(Get-EventSubscriber -ErrorAction SilentlyContinue | Where-Object { $_.SourceIdentifier -like 'tw*' })) {
    Unregister-Event -SubscriptionId $s.SubscriptionId -ErrorAction SilentlyContinue
  }
  foreach ($old in $script:watchers) { try { $old.EnableRaisingEvents = $false; $old.Dispose() } catch {} }
  $made = @()
  $n = 0
  foreach ($f in $paths) {
    $w = New-Object System.IO.FileSystemWatcher
    $w.Path = $f
    $w.IncludeSubdirectories = $false
    $w.NotifyFilter = [System.IO.NotifyFilters]::FileName
    $w.EnableRaisingEvents = $true
    # Deleted AND Renamed: a disappearance is not always an unlink. A move out of the
    # folder raises Renamed, and reading that as "nothing happened" would send the next
    # investigation hunting a deleter that never existed.
    $null = Register-ObjectEvent -InputObject $w -EventName Deleted -SourceIdentifier "twDel$n"
    $null = Register-ObjectEvent -InputObject $w -EventName Renamed -SourceIdentifier "twRen$n"
    $made += $w
    $n++
  }
  $script:watchers = $made
}

foreach ($f in $folders) { Write-TwLog "    watching $f" }
Set-TwWatchers $folders

# Beat once BEFORE the loop. The loop only beats after Wait-Event returns, so
# without this the heartbeat file does not exist for the first 30 seconds - during
# which the guard above reads "nobody is watching" and a second instance arms.
Set-Content -LiteralPath $ALIVE -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " pid=$PID folders=$($folders.Count)") -Encoding utf8

# --- drain ------------------------------------------------------------------
# Bursts are debounced to one capture per 20 s: a sweep across five folders raises
# five events, and five identical multi-megabyte process dumps would bury the one
# that matters.
$last = [datetime]::MinValue
$tick = 0
# The heartbeat LINE, once an hour, in the log itself. The .alive file only proves the
# watcher is running NOW; after routine removals stopped writing captures, the log can
# stay quiet for days, and a quiet stretch with no heartbeat lines in it means the
# tripwire was NOT running then - never that nothing happened.
$HEARTBEAT_MINUTES = if ($env:PHX_TW_BEAT_MIN) { [double]$env:PHX_TW_BEAT_MIN } else { 60 }
$lastBeat = Get-Date
function Write-TwHeartbeat {
  Write-TwLog ("### heartbeat - watching {0} folder(s), pid {1}; since the last heartbeat: {2} incident(s), {3} routine worktree removal(s), {4} Office/Excel temp file(s)" -f $folders.Count, $PID, $script:incidents, $script:routineWt, $script:routineLock)
  $script:incidents = 0; $script:routineWt = 0; $script:routineLock = 0
}
Write-TwHeartbeat
while ($true) {
  $ev = Wait-Event -Timeout 30

  # A heartbeat, overwritten rather than appended. It answers the question that
  # decides what a quiet log MEANS: was the tripwire actually watching at 05:46, or
  # had it died hours earlier? Without it, "nothing was logged" is unreadable.
  Set-Content -LiteralPath $ALIVE -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " pid=$PID folders=$($folders.Count)") -Encoding utf8
  if (((Get-Date) - $lastBeat).TotalMinutes -ge $HEARTBEAT_MINUTES) {
    $lastBeat = Get-Date
    Write-TwHeartbeat
  }

  if (-not $ev) {
    $tick++
    if (($tick % 4) -ne 0) { continue }
    # Idle tick: re-read the worktree set and re-arm if it moved. Compared as a
    # sorted, case-insensitive string so a reordering of git's output is not
    # mistaken for a change and does not churn the watchers every 30 s.
    try {
      $now = Get-TwFolders
      $a = ($folders | Sort-Object) -join '|'
      $b = ($now | Sort-Object) -join '|'
      if ($a -ne $b -and $now.Count -gt 0) {
        $gone  = @($folders | Where-Object { $now -notcontains $_ })
        $added = @($now | Where-Object { $folders -notcontains $_ })
        $folders = $now
        Set-TwWatchers $folders
        Write-TwLog "### re-armed on $($folders.Count) folder(s) - the worktree set changed"
        foreach ($g in $gone)  { Write-TwLog "###   dropped $g" }
        foreach ($x in $added) { Write-TwLog "###   added   $x" }
      }
    } catch {
      Write-TwLog "  RE-ARM FAILED: $($_.Exception.Message)"
    }
    continue
  }

  try {
    $a = $ev.SourceEventArgs
    if ($ev.SourceIdentifier -like 'twRen*') {
      $what = "RENAMED  $($a.OldFullPath)  ->  $($a.FullPath)"
      $gonePath = $a.OldFullPath; $otherPath = $a.FullPath
    } else {
      $what = "DELETED  $($a.FullPath)"
      $gonePath = $a.FullPath; $otherPath = ''
    }
    Remove-Event -EventIdentifier $ev.EventIdentifier -ErrorAction SilentlyContinue

    if (Test-TwRoutine $gonePath $otherPath) {
      # routine: already logged as one line, nothing captured, nothing restored
    } elseif (((Get-Date) - $last).TotalSeconds -lt 20) {
      Write-TwLog "  (same burst) $what"
    } else {
      $last = Get-Date
      Invoke-TwCapture $what
      # Drain the rest of the burst so every path is recorded, without re-capturing.
      foreach ($q in @(Get-Event -ErrorAction SilentlyContinue)) {
        $qa = $q.SourceEventArgs
        if ($qa -and $qa.FullPath) {
          $qGone = if ($qa.OldFullPath) { $qa.OldFullPath } else { $qa.FullPath }
          $qOther = if ($qa.OldFullPath) { $qa.FullPath } else { '' }
          if (-not (Test-TwRoutine $qGone $qOther)) { Write-TwLog "  (same burst) $($qa.FullPath)" }
        }
        Remove-Event -EventIdentifier $q.EventIdentifier -ErrorAction SilentlyContinue
      }
    }
  } catch {
    $script:inCapture = $false
    Write-TwLog "  HANDLER FAILED: $($_.Exception.Message)"
  }
}
