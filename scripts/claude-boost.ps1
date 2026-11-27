# claude-boost.ps1 — Claude Code Desktop first, everything else second. Closes nothing.
#
# Every run (scheduled task "Claude Boost": every 3 minutes, and at logon):
#   Claude desktop window, its GPU process and its main renderer  -> CPU priority High
#   every other Claude process, including each Code session        -> CPU priority AboveNormal
#   all Claude processes -> memory priority normal, and Windows efficiency mode OFF, so Windows
#                           never slows Claude down while its window is in the background
#   background apps (browsers, ChatGPT, mail, notes, Office, Zoom)  -> CPU BelowNormal,
#                           memory priority low, disk priority low
#   memory trim OFF by default since 2026-09-17 (owner decision): pushing background apps out to
#                           disk every 3 minutes freed about 40 MB a run while they paged straight
#                           back in; pass -TrimBelowMB 3000 by hand to use it once
#   the app in FRONT of the owner is never a background app, whatever its name: all of its
#                           processes go back to normal CPU, memory and disk priority and are
#                           never pushed to disk (owner decision 2026-09-17 - trimming the Excel
#                           or browser window he was typing in made it stutter, and the memory
#                           faulted straight back in)
#
# BelowNormal and low disk priority only bite when an app competes with Claude; with nothing to
# compete with, the browser still runs at full speed. Nothing is closed and no data is lost.
# Every setting lasts until that process restarts, which is why the task repeats.
# Last run: ~/.claude/scripts/claude-boost.last.txt
# By hand:  powershell -ExecutionPolicy Bypass -File ~/.claude/scripts/claude-boost.ps1

param([switch]$Quiet, [int]$TrimBelowMB = 0)

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# The native calls are compiled once into a DLL beside this script; compiling on every run would
# start the C# compiler every 3 minutes. v3 added the foreground-window calls; a new name, because an
# existing v2 DLL would otherwise load without them.
$dll = Join-Path $here 'claude-boost-native-v3.dll'
$src = @'
using System;
using System.Runtime.InteropServices;
namespace ClaudeBoost {
  public static class Native {
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);
    [DllImport("kernel32.dll")] public static extern bool SetProcessInformation(IntPtr h, int infoClass, [In] uint[] info, uint size);
    [DllImport("kernel32.dll")] public static extern bool GetProcessInformation(IntPtr h, int infoClass, [In, Out] uint[] info, uint size);
    [DllImport("ntdll.dll")] public static extern int NtSetInformationProcess(IntPtr h, int infoClass, ref int info, int size);
    [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int infoClass, ref int info, int size, IntPtr retLen);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  }
}
'@
if (-not ('ClaudeBoost.Native' -as [type]) -and -not (Test-Path $dll)) {
  try { Add-Type -TypeDefinition $src -OutputAssembly $dll -OutputType Library -ErrorAction Stop } catch {}
}
if (-not ('ClaudeBoost.Native' -as [type]) -and (Test-Path $dll)) {
  try { Add-Type -Path $dll -ErrorAction Stop } catch {}
}
if (-not ('ClaudeBoost.Native' -as [type])) { Add-Type -TypeDefinition $src }

# PROCESS_SET_INFORMATION | PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION
$ACCESS = 0x0200 -bor 0x0100 -bor 0x0400
$ProcessMemoryPriority = 0
$ProcessPowerThrottling = 4
$ProcessIoPriority = 33

# memPriority: 5 normal, 2 low. throttle: $false = efficiency mode OFF (HighQoS), $null = leave it.
# ioPriority: 1 low, -1 leave it.
function Tune([int]$procId, [uint32]$memPriority, $throttle, [int]$ioPriority, [bool]$trim) {
  $h = [ClaudeBoost.Native]::OpenProcess($ACCESS, $false, $procId)
  if ($h -eq [IntPtr]::Zero) { return $false }
  try {
    [void][ClaudeBoost.Native]::SetProcessInformation($h, $ProcessMemoryPriority, [uint32[]]@($memPriority), 4)
    if ($throttle -eq $false) {
      # PROCESS_POWER_THROTTLING_STATE: Version 1, ControlMask EXECUTION_SPEED, StateMask 0 = never throttle
      [void][ClaudeBoost.Native]::SetProcessInformation($h, $ProcessPowerThrottling, [uint32[]]@(1, 1, 0), 12)
    }
    if ($ioPriority -ge 0) { $io = $ioPriority; [void][ClaudeBoost.Native]::NtSetInformationProcess($h, $ProcessIoPriority, [ref]$io, 4) }
    if ($trim) { [void][ClaudeBoost.Native]::EmptyWorkingSet($h) }
    return $true
  } finally { [void][ClaudeBoost.Native]::CloseHandle($h) }
}

function FreeMB { [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024) }
$before = FreeMB

# 1. Claude first.
$high = 0; $above = 0
foreach ($cim in (Get-CimInstance Win32_Process -Filter "Name='claude.exe'")) {
  $p = Get-Process -Id $cim.ProcessId
  if (-not $p) { continue }
  $cmd = [string]$cim.CommandLine
  $isSession = ([string]$cim.ExecutablePath) -like '*\claude-code\*'
  $isDesktopMain = -not $isSession -and $cmd -notmatch '--type='
  $isGpu = $cmd -match '--type=gpu-process'
  $isMainRenderer = $cmd -match '--type=renderer' -and $p.WorkingSet64 -ge 300MB
  if (-not $isSession -and ($isDesktopMain -or $isGpu -or $isMainRenderer)) {
    if ($p.PriorityClass -ne 'High') { $p.PriorityClass = 'High' }
    $high++
  } else {
    if ($p.PriorityClass -ne 'High' -and $p.PriorityClass -ne 'AboveNormal') { $p.PriorityClass = 'AboveNormal' }
    $above++
  }
  [void](Tune $p.Id 5 $false -1 $false)
}

# 2. Background apps give way.
$background = 'msedge','chrome','ChatGPT Classic','ChatGPT','Mailbird','Notion','Zoom','Simplenote',
              'CefSharp.BrowserSubprocess','Photos','EXCEL','POWERPNT','WINWORD','SnippingTool','ShareX',
              'OneDrive','OneDrive.Sync.Service','Spotify','Teams','ms-teams','WhatsApp','Telegram','Discord'
$trim = $before -lt $TrimBelowMB
$lowered = 0
# The app in front: matched by process NAME, so a browser's tab and GPU processes are spared with its
# window. It is actively restored, because an earlier run may have lowered it while it was behind.
$front = $null
$frontPid = [uint32]0
$hwnd = [ClaudeBoost.Native]::GetForegroundWindow()
if ($hwnd -ne [IntPtr]::Zero) { [void][ClaudeBoost.Native]::GetWindowThreadProcessId($hwnd, [ref]$frontPid) }
if ($frontPid -gt 0) { $front = (Get-Process -Id $frontPid).ProcessName }
$spared = 0
foreach ($name in $background) {
  foreach ($p in (Get-Process -Name $name)) {
    if ($front -and $p.ProcessName -eq $front) {
      if ($p.PriorityClass -eq 'BelowNormal' -or $p.PriorityClass -eq 'Idle') { $p.PriorityClass = 'Normal' }
      if (Tune $p.Id 5 $null 2 $false) { $spared++ }
      continue
    }
    if ($p.PriorityClass -ne 'BelowNormal' -and $p.PriorityClass -ne 'Idle') { $p.PriorityClass = 'BelowNormal' }
    if (Tune $p.Id 2 $null 1 $trim) { $lowered++ }
  }
}

if ($trim) { Start-Sleep -Milliseconds 800 }
$after = FreeMB
$frontNote = if ($spared -gt 0) { '{0} ({1} processes)' -f $front, $spared } elseif ($front) { '{0} (not a listed app)' -f $front } else { 'none' }
$line = '{0:yyyy-MM-dd HH:mm:ss}  Claude: {1} at High, {2} at AboveNormal, efficiency mode off  |  background lowered: {3}  |  memory trimmed: {4}  |  in front, spared: {7}  |  free RAM {5} -> {6} MB' -f (Get-Date), $high, $above, $lowered, $(if ($trim) { 'yes' } else { 'no' }), $before, $after, $frontNote
Set-Content -Path (Join-Path $here 'claude-boost.last.txt') -Value $line -Encoding UTF8
if (-not $Quiet) { $line }
