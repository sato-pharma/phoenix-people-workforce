<#
Installs the RAM cleaner as an ELEVATED task (owner, 2026-11-19: "run the RAM cleaner elevated").

Why a separate locked folder: an admin task that runs a script from ~\.claude\scripts would let
ANY process running as the owner (a session, an npm package) edit that script and get admin
rights every 5 minutes. So the elevated copy lives in C:\ProgramData\PhoenixRamCleaner, which
only Administrators and SYSTEM can write; everyone else can only read it. Its dll, state and log
stay in that folder too.

Editing ~\.claude\scripts\ram-cleaner.ps1 does NOT change the elevated copy: re-run this
installer (as admin) to push an edit.

Run from an ADMIN PowerShell, or let it ask for elevation itself (one UAC "Yes").
#>
$ErrorActionPreference = 'Stop'
$src  = Join-Path $env:USERPROFILE '.claude\scripts\ram-cleaner.ps1'
$dir  = 'C:\ProgramData\PhoenixRamCleaner'
$name = 'Phoenix RAM Cleaner - Every 5 Min'
$user = "$env:USERDOMAIN\$env:USERNAME"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File',"`"$PSCommandPath`"")
  return
}

# 1. a fresh copy of the script (an old dll is dropped so the new copy compiles its own)
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
Copy-Item -LiteralPath $src -Destination (Join-Path $dir 'ram-cleaner.ps1') -Force
Remove-Item -LiteralPath (Join-Path $dir 'PhxRam.v1.dll') -Force -ErrorAction SilentlyContinue

# 2. lock it: owner Administrators; Administrators + SYSTEM full control, Users read/execute only;
#    nothing inherited from C:\ProgramData; every file inside takes exactly the folder's rules
& icacls $dir /setowner '*S-1-5-32-544' /T /C | Out-Null
& icacls $dir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed ($LASTEXITCODE) - task NOT registered" }
& icacls (Join-Path $dir '*') /reset /T /C | Out-Null

# 3. the same task name, now run with highest privileges from the locked copy
$script = Join-Path $dir 'ram-cleaner.ps1'
$taskArgs = '--headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Apply -WorkDir "{1}" -LogFile "{2}"' -f $script, $dir, (Join-Path $dir 'ram-cleaner.log')
$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $taskArgs
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$l = New-ScheduledTaskTrigger -AtLogOn -User $user
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
$p = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $name -Action $a -Trigger $t,$l -Settings $s -Principal $p -Force `
  -Description 'ELEVATED, every 5 min: trims processes asleep a whole cycle (anything idle under 1,800 MB free), ends only dead-parent test/build leftovers. Never a session, the app, a dev server or the foreground app. Runs the locked copy in C:\ProgramData\PhoenixRamCleaner (admin-write only); log there. Owner ask 2026-11-19.' | Out-Null

# 4. prove it
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 15
$i = Get-ScheduledTaskInfo -TaskName $name
"task result $($i.LastTaskResult) (0 = OK), next run $($i.NextRunTime)"
& icacls $dir
Get-Content (Join-Path $dir 'ram-cleaner.log') -Tail 2 -ErrorAction SilentlyContinue
'Done - you can close this window.'
