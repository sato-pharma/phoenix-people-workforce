<#
Phoenix Workforce RAM RECLAIM  --  the NON-DESTRUCTIVE half of the memory guard.
================================================================================
WHY THIS EXISTS:
  mem-watchdog.ps1 has exactly ONE tool (kill) and, in practice, ONE eligible target
  (an idle `next dev` server). Everything else on this box is in its $Protected list --
  correctly, because killing the owner's browser tabs or Claude sessions is worse than
  being slow. So when physical RAM hits the floor and there is no idle dev server to
  reap, the watchdog logs

      "PRESSURE physical RAM 356MB available (floor 1800)
       - no IDLE dev server to reclaim; left everything running on purpose."

  ...every ten seconds, and reclaims NOTHING. Measured 2026-09-08 01:19-01:22, over a
  hundred consecutive such lines, bottoming at 356 MB available. That is deep inside the
  paging-crawl regime the rule was written to prevent. The guard was not misconfigured;
  it had no move to make.

WHAT THIS ADDS:
  A second tool that does not kill anything. EmptyWorkingSet (K32EmptyWorkingSet) evicts
  a process's resident pages -- clean pages to the standby list, dirty pages to the
  pagefile -- while the process keeps running with all of its state. Windows faults back
  only what is actually touched again. It is precisely what the OS does under pressure,
  except aimed at IDLE processes instead of at whatever happens to be unlucky.

  That makes the exact class the watchdog refuses to KILL perfectly safe to TRIM:
  96 browser processes sitting on background tabs, an idle Claude session, Excel left
  open, Mailbird. Nothing is lost. Measured on this box: one idle process, 169 MB -> 0 MB.

WHY IDLENESS IS LOAD-BEARING, NOT A NICETY:
  Trimming a process that is actively working makes it fault its pages straight back in,
  which is a disk-I/O burst -- the "throttled" feeling itself. So a process is only
  trimmed when it shows no measurable CPU across the sample window, and the FOREGROUND
  window's process is never trimmed at any size. Skipping those two gates would turn this
  script into a cause of the problem it fixes.

USAGE:
  powershell -NoProfile -ExecutionPolicy Bypass -File ram-reclaim.ps1
  ...          -WhatIf          show what would be trimmed, change nothing
  ...          -MinPrivateMB 80 only bother with processes above this size

  Safe to run at any time, by hand or on a schedule. It never terminates a process.
#>

param(
  [int]$MinPrivateMB    = 50,     # ignore processes smaller than this - not worth the syscall
  [double]$IdleCpuSec   = 0.05,   # CPU-seconds across the sample window that still counts as idle
  [int]$SampleMs        = 1500,   # how long to watch CPU before deciding a process is idle
  [switch]$WhatIf,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

# Never trim these, at any size.
#   - PID <= 4 and the kernel pseudo-processes cannot be opened at all.
#   - dwm is the compositor that paints every window; trimming it is visible stutter for
#     ~107 MB, which is a bad trade in both directions.
#   - MsMpEng (Defender) re-faults immediately and aggressively.
#   - Memory Compression IS the standby cache; trimming it is circular.
$NeverTrim = @(
  'System','Idle','Registry','Memory Compression','Secure System','csrss','wininit',
  'winlogon','services','lsass','smss','svchost','dwm','fontdrvhost','MsMpEng',
  'SecurityHealthService','LsaIso','WUDFHost'
)

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class PhxWs {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool K32EmptyWorkingSet(IntPtr hProcess);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
if (-not ('PhxWs' -as [type])) { Add-Type -TypeDefinition $sig }

function Get-AvailMB {
  try { return [int](Get-Counter '\Memory\Available MBytes' -EA Stop).CounterSamples[0].CookedValue }
  catch { return [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB) }
}

# The foreground window's process is exempt: it is what the owner is looking at.
$fgPid = 0
try { [void][PhxWs]::GetWindowThreadProcessId([PhxWs]::GetForegroundWindow(), [ref]$fgPid) } catch {}

$availBefore = Get-AvailMB

# --- sample CPU so we can tell idle from working ------------------------------
$cand = Get-Process -EA SilentlyContinue | Where-Object {
  $_.Id -gt 4 -and
  $_.Id -ne $PID -and
  $_.Id -ne $fgPid -and
  ($NeverTrim -notcontains $_.ProcessName) -and
  ($_.PrivateMemorySize64 / 1MB) -ge $MinPrivateMB
}

$cpu0 = @{}
foreach ($p in $cand) { try { $cpu0[$p.Id] = $p.CPU } catch {} }
Start-Sleep -Milliseconds $SampleMs

$trimmed = 0; $reclaimed = 0.0; $skippedBusy = 0; $skippedDenied = 0
$detail = @()

foreach ($p in $cand) {
  try { $p.Refresh() } catch { continue }
  if ($p.HasExited) { continue }

  # idle gate -- the load-bearing one (see header)
  $delta = $null
  try { if ($cpu0.ContainsKey($p.Id)) { $delta = $p.CPU - $cpu0[$p.Id] } } catch {}
  if ($null -eq $delta) { continue }
  if ($delta -gt $IdleCpuSec) { $skippedBusy++; continue }

  $beforeMB = $p.WorkingSet64 / 1MB
  if ($beforeMB -lt 1) { continue }

  if ($WhatIf) {
    $trimmed++; $reclaimed += $beforeMB
    $detail += [pscustomobject]@{ PID=$p.Id; Name=$p.ProcessName; WS_MB=[math]::Round($beforeMB); Freed_MB='(whatif)' }
    continue
  }

  try {
    $h = $p.Handle                       # throws for processes we may not open - caught below
    if ([PhxWs]::K32EmptyWorkingSet($h)) {
      $p.Refresh()
      $freed = $beforeMB - ($p.WorkingSet64 / 1MB)
      if ($freed -gt 0) {
        $trimmed++; $reclaimed += $freed
        if ($freed -ge 20) {
          $detail += [pscustomobject]@{ PID=$p.Id; Name=$p.ProcessName; WS_MB=[math]::Round($beforeMB); Freed_MB=[math]::Round($freed) }
        }
      }
    }
  } catch { $skippedDenied++ }
}

Start-Sleep -Milliseconds 600
$availAfter = Get-AvailMB

if (-not $Quiet) {
  if ($detail.Count) {
    ($detail | Sort-Object Freed_MB -Descending | Select-Object -First 20 | Format-Table -AutoSize | Out-String).Trim()
    ""
  }
  "processes trimmed : {0}   (skipped: {1} busy, {2} not openable)" -f $trimmed, $skippedBusy, $skippedDenied
  "working set freed : {0:N0} MB" -f $reclaimed
  "available RAM     : {0:N0} MB -> {1:N0} MB   ({2:+#,##0;-#,##0;0} MB)" -f $availBefore, $availAfter, ($availAfter - $availBefore)
}

# Machine-readable line for the watchdog to fold into its own log.
"RECLAIM trimmed=$trimmed freedMB=$([math]::Round($reclaimed)) availBefore=$availBefore availAfter=$availAfter"
