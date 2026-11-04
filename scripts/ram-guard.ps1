<#
Phoenix Workforce RAM Guard
===========================
Runs every 30 min via Windows Task Scheduler (task name "PhoenixWorkforce RAM Guard"),
independent of any Claude Code session — the whole point is to cost ~0 RAM between runs,
so it must not itself be a long-lived process (a live Claude Code loop would defeat the
goal: it'd be one more session holding memory for the entire working day).

WHAT IT DOES:
  1. Reports free RAM and classifies each real Claude Code CLI session (not the Electron
     desktop shell's ~14 helper processes) as idle/active by CPU-delta over a sampling
     window — a session waiting on the model's response burns ~no local CPU, same as one
     sitting untouched, so this is a proxy, not a perfect signal. It only ever reports.
  2. Deletes temp files older than a few days from $env:TEMP (best-effort, locked files
     are skipped, never an error) - never under $env:TEMP\claude (session scratchpads) and
     never a document or image file anywhere (owner rule 2026-09-14).
  3. Calls into this repo's own scripts/repo-doctor.mjs on a throttled cadence — --fix
     (husk directories only) and --strip-idle (node_modules/.next from worktrees already
     proven clean, fully pushed, and idle 2h+). Both flags have their own hard safety
     gates inside repo-doctor.mjs itself, including refusing to run at all when more than
     one real Claude Code session is live — this script does not try to work around that,
     it just calls the tool and logs whatever it decides.
  4. Alerts (log line + best-effort toast) when RAM is low AND idle sessions exist, naming
     them so the owner can close the tabs by hand. Debounced so it does not repeat every
     30 minutes while the condition persists.

WHAT IT NEVER DOES: close a session, kill a process, remove a worktree with content, or
delete a branch. Every destructive-adjacent action here is either report-only or backed by
repo-doctor.mjs's own proof-before-delete guards (see that file for the full reasoning).

Log:   C:\Users\satoh\.claude\scripts\ram-guard.log        (trimmed to last 500 lines)
State: C:\Users\satoh\.claude\scripts\ram-guard-state.json  (throttle + alert-debounce timestamps)
#>

$ErrorActionPreference = 'Stop'

# ---- config -----------------------------------------------------------------
$RepoPath               = 'F:\Phoenix Workforce\phoenix-workforce'
$ScriptDir              = 'C:\Users\satoh\.claude\scripts'
$LogPath                = Join-Path $ScriptDir 'ram-guard.log'
$StatePath              = Join-Path $ScriptDir 'ram-guard-state.json'
$WatchdogScript         = Join-Path $ScriptDir 'mem-watchdog.ps1'
# The ceiling on this machine is the Windows COMMIT charge (RAM + pagefile), NOT free physical
# RAM. Free RAM stays low through ordinary file caching even when commit headroom is large, so the
# old pair ($LowFreeRamGB = 2.5, $MaxHealthySessions = 4) alerted constantly while nothing was
# wrong — and an alert that cries wolf is worse than none. The pagefile was raised to a fixed 16GB
# on 2026-08-25, taking the limit from ~19.79GB to 31.79GB, which also made a fixed session cap
# meaningless (AGENTS.md §5 corrected in PR #2409).
#   UPDATE 2026-08-26: the in-place Windows reinstall that morning RESET the pagefile to
#   system-managed, discarding that fix, and the box froze again at 11:13 the same day (node.exe
#   36.9GB, dwm 0xc00001ad, Kernel-Power 41). It was re-pinned the same afternoon to
#   InitialSize 32768 / MaximumSize 65536 MB, so from the next reboot the limit is ~47.8GB, not
#   31.79GB. This threshold is a PERCENTAGE of the live limit and therefore needed no edit -
#   do NOT convert it to an absolute GB figure, or the next pagefile change silently breaks it.
# 85% matches ~/.claude/hooks/memory-guard.mjs
# and ~/.claude/hooks/statusline.mjs deliberately — one threshold, not three. It is 85 and not 100
# because the freeze happens during an allocation SPIKE: at 100% the box is already wedged.
$CommitWarnPct          = 85
$FallbackLowFreeRamGB   = 1.0     # ONLY when commit is unreadable — never a primary signal
# ---- PHYSICAL RAM PRESSURE (added 2026-09-01) ---------------------------------------
# The paragraph above is right that FreePhysicalMemory is cache-inflated and must not be a
# primary signal. It then over-corrects into ignoring physical memory ALTOGETHER, and that
# blind spot cost the owner a whole night: at 01:09 on 2026-09-01 this script logged
# "COMMIT: 28.15/47.79 GB (59%)" and stayed silent, while available physical RAM was under
# 900 MB, dwm.exe had been trimmed to 4% resident, and hard faults were running at 3,551/sec.
# Commit-based rules CANNOT see that state, because the large pagefile is exactly what lets
# the box commit 3x its RAM instead of freezing. AvailableMBytes (free + standby) is the
# honest gauge - unlike FreePhysicalMemory it already accounts for reclaimable cache, so a
# low reading here means real pressure, not bookkeeping.
$LowAvailableRamMB      = 1800
$CpuSampleSeconds       = 20      # memory note: judge idleness by CPU delta, never by start time
$CpuIdleThresholdSec    = 0.5     # CPU-seconds burned in the sample window below which = idle
$AlertDebounceMinutes   = 60      # do not re-notify more than once an hour while low RAM persists
$FixIntervalHours       = 3       # husk scan costs ~70s of disk-wait even when it finds nothing
$StripIdleIntervalHours = 20      # the build-cache reclaim is much slower — see repo-doctor.mjs
$TempFileAgeDays        = 3
$MaxLogLines            = 500

# ---- helpers ------------------------------------------------------------------
function Get-CairoNow {
    try {
        $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById('Egypt Standard Time')
        return [System.TimeZoneInfo]::ConvertTimeFromUtc((Get-Date).ToUniversalTime(), $tz)
    } catch {
        return (Get-Date).ToUniversalTime().AddHours(2)
    }
}

function Write-Log {
    param([string]$Line)
    $stamped = "[{0:yyyy-MM-dd HH:mm:ss} Cairo] {1}" -f (Get-CairoNow), $Line
    Write-Output $stamped
    Add-Content -Path $LogPath -Value $stamped -Encoding utf8
}

function Get-GuardState {
    if (Test-Path $StatePath) {
        try { return Get-Content $StatePath -Raw | ConvertFrom-Json } catch { }
    }
    return [PSCustomObject]@{ lastAlertAt = $null; lastFixAt = $null; lastStripIdleAt = $null }
}

function Save-GuardState($state) {
    $state | ConvertTo-Json | Set-Content -Path $StatePath -Encoding utf8
}

function Minutes-Since($isoTimestamp) {
    if (-not $isoTimestamp) { return [double]::PositiveInfinity }
    try { return ((Get-Date).ToUniversalTime() - [DateTime]::Parse($isoTimestamp).ToUniversalTime()).TotalMinutes }
    catch { return [double]::PositiveInfinity }
}

function Show-Notification {
    param([string]$Title, [string]$Message)
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $icon = New-Object System.Windows.Forms.NotifyIcon
        $icon.Icon = [System.Drawing.SystemIcons]::Warning
        $icon.Visible = $true
        $icon.BalloonTipTitle = $Title
        $icon.BalloonTipText = $Message
        $icon.ShowBalloonTip(15000)
        Start-Sleep -Seconds 5
        $icon.Dispose()
    } catch {
        Write-Log "  (notification failed: $($_.Exception.Message))"
    }
}

# ---- main -----------------------------------------------------------------------
try {
    New-Item -ItemType Directory -Force -Path $ScriptDir | Out-Null
    $state = Get-GuardState

    $os = Get-CimInstance Win32_OperatingSystem
    $freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
    $totalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)

    # Commit charge — the figure that actually predicts a freeze. Same CIM object already fetched
    # above, so this costs no extra call. TotalVirtualMemorySize is the commit LIMIT and
    # FreeVirtualMemory the headroom, both in KB (hence /1MB to reach GB).
    $commitLimitGB = [math]::Round($os.TotalVirtualMemorySize / 1MB, 2)
    $commitUsedGB  = [math]::Round(($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1MB, 2)
    $commitPct     = if ($commitLimitGB -gt 0) { [math]::Round(($commitUsedGB / $commitLimitGB) * 100) } else { $null }

    # Real Claude Code CLI sessions only — same filter scripts/repo-doctor.mjs uses to
    # exclude the Electron desktop shell's own helper processes (WindowsApps\Claude.exe).
    $sessions = @(Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*claude-code*' })

    $before = @{}
    foreach ($p in $sessions) { $before[$p.Id] = $p.CPU }
    if ($sessions.Count -gt 0) { Start-Sleep -Seconds $CpuSampleSeconds }

    $idle = @()
    $active = @()
    foreach ($p in $sessions) {
        try {
            $p.Refresh()
            $delta = $p.CPU - $before[$p.Id]
        } catch { continue } # exited mid-sample
        $row = [PSCustomObject]@{ Id = $p.Id; StartTime = $p.StartTime; WS_MB = [math]::Round($p.WorkingSet64/1MB); DeltaCPU = [math]::Round($delta,2) }
        if ($delta -lt $CpuIdleThresholdSec) { $idle += $row } else { $active += $row }
    }

    # AvailableMBytes = free + standby, i.e. what a new allocation can actually have without
    # evicting somebody's working set. Read it BEFORE logging so the line carries both ceilings.
    $availMB = $null
    try { $availMB = [int](Get-CimInstance Win32_PerfRawData_PerfOS_Memory -ErrorAction Stop).AvailableMBytes } catch { }
    $ramPressure = ($null -ne $availMB) -and ($availMB -lt $LowAvailableRamMB)

    Write-Log ("COMMIT: {0}/{1} GB ({2}%) - freeze ceiling. RAM AVAILABLE: {3} MB{4} - paging ceiling; below {5} MB the desktop gets evicted to the pagefile and everything crawls at idle CPU. (raw free {6} GB / {7} GB total). Claude CLI sessions: {8} ({9} idle / {10} active by {11}s CPU-delta)." -f `
        $commitUsedGB, $commitLimitGB, $commitPct, `
        $(if ($null -ne $availMB) { $availMB } else { 'unreadable' }), `
        $(if ($ramPressure) { ' *** PRESSURE ***' } else { '' }), `
        $LowAvailableRamMB, $freeGB, $totalGB, `
        $sessions.Count, $idle.Count, $active.Count, $CpuSampleSeconds)
    foreach ($r in $idle)   { Write-Log ("  idle   PID {0,-7} started {1:HH:mm}  {2,4} MB  {3}s CPU used" -f $r.Id, $r.StartTime, $r.WS_MB, $r.DeltaCPU) }
    foreach ($r in $active) { Write-Log ("  active PID {0,-7} started {1:HH:mm}  {2,4} MB  {3}s CPU used" -f $r.Id, $r.StartTime, $r.WS_MB, $r.DeltaCPU) }

    # Other heavy processes, for visibility only — never touched.
    $sessionIds = @($sessions | Select-Object -ExpandProperty Id)
    $others = Get-Process | Where-Object { ($sessionIds -notcontains $_.Id) -and $_.WorkingSet64 -gt 150MB } |
        Sort-Object WorkingSet64 -Descending | Select-Object -First 6
    if ($others) {
        Write-Log "  other heavy processes (>150MB, not touched):"
        foreach ($o in $others) { Write-Log ("    {0,-20} PID {1,-7} {2,4} MB" -f $o.ProcessName, $o.Id, [math]::Round($o.WorkingSet64/1MB)) }
    }

    # ---- safe cleanup: temp files older than N days, best-effort ----------------
    # Owner rule 2026-09-14: never delete an HTML, PDF, XLSX/XLSM/CSV, DOCX, SVG or image file in ANY
    # folder, scratchpads included - and Claude Code session scratchpads live under $env:TEMP\claude.
    # So that whole tree is skipped, and those document types are skipped everywhere else in TEMP too
    # (same extension list as ~/.claude/hooks/scratchpad-guard.mjs). Added 2026-09-17 by the settings review.
    $cutoff = (Get-Date).AddDays(-$TempFileAgeDays)
    $removedCount = 0
    $claudeTemp = (Join-Path $env:TEMP 'claude') + '\'
    $protectedExt = '^\.(html?|pdf|xlsx|xlsm|xls|csv|docx?|svg|png|jpe?g|webp|gif|bmp)$'
    Get-ChildItem -Path $env:TEMP -File -Recurse -ErrorAction SilentlyContinue | Where-Object {
        $_.LastWriteTime -lt $cutoff -and
        -not $_.FullName.StartsWith($claudeTemp, [System.StringComparison]::OrdinalIgnoreCase) -and
        $_.Extension -notmatch $protectedExt
    } | ForEach-Object {
        try { Remove-Item $_.FullName -Force -ErrorAction Stop; $removedCount++ } catch { }
    }
    if ($removedCount -gt 0) { Write-Log "  cleaned $removedCount temp file(s) older than $TempFileAgeDays day(s) from $env:TEMP" }

    # ---- throttled repo-doctor: husk fix + build-cache reclaim -------------------
    # Both calls trust repo-doctor.mjs's OWN concurrent-session guard completely — it already
    # refuses to touch anything while more than one real Claude Code session is live, and
    # fails closed if it cannot even count them. This script does not duplicate that logic
    # or pass --force; it just runs the tool and logs whatever it decided.
    #
    # Uses Start-Process with file-redirected stdout/stderr rather than `& node ... 2>&1`.
    # In Windows PowerShell 5.1, `2>&1` on a native command wraps every stderr LINE in an
    # ErrorRecord on the success pipeline, and with $ErrorActionPreference = 'Stop' (set at
    # the top of this file) that turns repo-doctor's own expected refusal message — plain
    # console.error text — into a terminating exception here. That exception skipped
    # Save-GuardState below, so the throttle timestamps never persisted and every run would
    # retry both calls forever. Caught by actually reading this script's own first log line.
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    $doctorScript = Join-Path $RepoPath 'scripts\repo-doctor.mjs'

    function Invoke-RepoDoctor {
        param([string[]]$DoctorArgs, [string]$Label, [int]$TimeoutSeconds = 720)
        $stdoutFile = [System.IO.Path]::GetTempFileName()
        $stderrFile = [System.IO.Path]::GetTempFileName()
        try {
            # The path itself must be individually quoted before going into -ArgumentList:
            # Start-Process joins array elements with plain spaces and does NOT quote an
            # element just because it contains one, so an unquoted "F:\Phoenix Workforce\..."
            # arrives at node as two argv entries split at the space, and node fails with
            # "Cannot find module 'F:\Phoenix'". Verified by reproducing it against a throwaway
            # script under a space-containing path before landing this fix.
            $quotedScript = '"' + $doctorScript + '"'
            $startArgs = @{
                FilePath               = $nodeCmd.Source
                ArgumentList           = @($quotedScript) + $DoctorArgs
                WorkingDirectory       = $RepoPath
                NoNewWindow            = $true
                PassThru               = $true
                RedirectStandardOutput = $stdoutFile
                RedirectStandardError  = $stderrFile
            }
            $proc = Start-Process @startArgs
            # Touching .Handle immediately is required for .ExitCode to read back correctly
            # after the process exits — a documented .NET Process quirk, also verified directly:
            # without it ExitCode came back as an empty string even though the process ran fine.
            $proc.Handle | Out-Null
            $exited = $proc.WaitForExit($TimeoutSeconds * 1000)
            if (-not $exited) {
                Write-Log "  $Label timed out after ${TimeoutSeconds}s - left it running rather than kill it; it only ever deletes proven-safe paths."
                return
            }
            $combined = @()
            if (Test-Path $stdoutFile) { $combined += Get-Content $stdoutFile }
            if (Test-Path $stderrFile) { $combined += Get-Content $stderrFile }
            Write-Log "  ${Label}: (exit $($proc.ExitCode))"
            $combined | Where-Object { $_.Trim() } | ForEach-Object { Write-Log "    $_" }
        } catch {
            Write-Log "  $Label failed to launch: $($_.Exception.Message)"
        } finally {
            Remove-Item $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
        }
    }

    if ($nodeCmd -and (Test-Path $doctorScript)) {
        if ((Minutes-Since $state.lastFixAt) -ge ($FixIntervalHours * 60)) {
            # --no-auth (2026-09-17): without it every run paged the PRODUCTION GoTrue admin API for the
            # orphan-auth-user report, which the husk fix does not need, and that report forced exit 1.
            Invoke-RepoDoctor -DoctorArgs @('--fix', '--no-auth') -Label 'repo-doctor --fix'
            $state.lastFixAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        if ((Minutes-Since $state.lastStripIdleAt) -ge ($StripIdleIntervalHours * 60)) {
            Invoke-RepoDoctor -DoctorArgs @('--strip-idle', '--no-auth') -Label 'repo-doctor --strip-idle' -TimeoutSeconds 900
            $state.lastStripIdleAt = (Get-Date).ToUniversalTime().ToString('o')
        }
    } else {
        Write-Log "  repo-doctor skipped: node not on PATH or script not found at $doctorScript"
    }

    # ---- keep the memory watchdog alive (added 2026-08-26) --------------------------
    # mem-watchdog.ps1 is the only thing that actually PREVENTS a freeze - THIS script reports and
    # by design never kills, which is why it never stopped one. On 2026-08-26 the watchdog died
    # with LastTaskResult 3221225786 = 0xC000013A (STATUS_CONTROL_C_EXIT, a console close) and
    # nothing revived it: its task was registered without -RestartCount, and re-registering to add
    # one needs an ELEVATED shell (a normal shell gets 0x80070005 Access Denied). This is the
    # non-elevated substitute - a 30-minute ceiling on how long the box can sit unprotected.
    # Starting a process is additive; this block still never kills anything.
    #
    # The match MUST be on '-File' and exclude $PID: a CommandLine LIKE '*mem-watchdog.ps1*' also
    # matches any QUERY about the script, which produced two false "already running" readings.
    try {
        $wd = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop |
                Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*-File*mem-watchdog.ps1*' })
        if ($wd.Count -gt 0) {
            Write-Log "  memory watchdog: alive (pid $($wd[0].ProcessId))"
        } elseif (Test-Path $WatchdogScript) {
            Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
                '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$WatchdogScript) | Out-Null
            Write-Log "  memory watchdog: was DEAD - restarted it"
        } else {
            Write-Log "  memory watchdog: script MISSING at $WatchdogScript"
        }
    } catch {
        Write-Log "  memory watchdog check failed: $($_.Exception.Message)"
    }

    # ---- alert (never act) ---------------------------------------------------------
    # Same condition as memory-guard.mjs's SessionStart warning — this is the continuous version of
    # that check, for the stretches of a work day when no new session starts to trigger it. Free
    # RAM is consulted ONLY if commit could not be read at all.
    $saturated = if ($null -ne $commitPct) { $commitPct -ge $CommitWarnPct } else { $freeGB -lt $FallbackLowFreeRamGB }

    # TWO independent conditions, not one (added 2026-09-01). Commit saturation predicts a
    # FREEZE; available-RAM starvation predicts a CRAWL. They are different failures with
    # different cures, and on 2026-09-01 the second happened alone - commit 59%, RAM under
    # 900 MB - so a single commit-only test stayed quiet through the whole event.
    #
    # The old test also required $idle.Count -gt 0, i.e. it could only fire when an idle
    # CLAUDE session existed to blame. That night the memory was held by next dev servers and
    # every session was busy, so even a correct pressure reading would have been swallowed.
    # Pressure is now reported on its own evidence, and names whatever is actually holding it.
    $alertReason = $null
    if ($saturated -and $idle.Count -gt 0) {
        $idleIds = ($idle | Select-Object -ExpandProperty Id) -join ', '
        $alertReason = "Commit $commitUsedGB/$commitLimitGB GB ($commitPct%) - a freeze is close. $($sessions.Count) sessions, $($idle.Count) look idle (PIDs: $idleIds). Consider closing some in the app's session list."
    } elseif ($ramPressure) {
        $hog = Get-Process | Where-Object { $_.Id -gt 4 -and $_.ProcessName -notin @('claude','Claude') } |
               Sort-Object PM -Descending | Select-Object -First 1
        $hogText = if ($hog) { " Largest non-Claude process: $($hog.ProcessName) pid $($hog.Id) at $([math]::Round($hog.PM/1GB,2)) GB." } else { '' }
        $alertReason = "Physical RAM available is ${availMB} MB (floor $LowAvailableRamMB). Windows is evicting working sets to the pagefile - this is why the UI feels slow while CPU sits idle.$hogText"
    }
    if ($alertReason -and (Minutes-Since $state.lastAlertAt) -ge $AlertDebounceMinutes) {
        Write-Log "ALERT: $alertReason"
        Show-Notification -Title "Phoenix Workforce RAM Guard" -Message $alertReason
        $state.lastAlertAt = (Get-Date).ToUniversalTime().ToString('o')
    }

    Save-GuardState $state

    # ---- trim log --------------------------------------------------------------------
    if (Test-Path $LogPath) {
        $lines = @(Get-Content $LogPath)
        if ($lines.Count -gt $MaxLogLines) {
            $lines[($lines.Count - $MaxLogLines)..($lines.Count - 1)] | Set-Content -Path $LogPath -Encoding utf8
        }
    }
} catch {
    try { Add-Content -Path $LogPath -Value ("[{0}] FATAL: {1}" -f (Get-Date), $_.Exception.Message) -Encoding utf8 } catch { }
}
