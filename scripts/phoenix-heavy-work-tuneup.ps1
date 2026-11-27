<#
phoenix-heavy-work-tuneup.ps1 - OWNER-RUN, ELEVATED. Written 2026-09-11 (Cairo), after two bluescreens.

HOW TO RUN (from a PowerShell window opened with "Run as administrator"):
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\satoh\.claude\scripts\phoenix-heavy-work-tuneup.ps1"

Every step asks first: type y to do it, press Enter to skip. Nothing restarts the machine.
A full transcript goes to C:\Users\satoh\.claude\scripts\phoenix-heavy-work-tuneup.log, and every
change prints the command that undoes it.

WHY: the four minidumps (2026-08-26, 09-04, 09-11 twice) are 0x116, 0x9F and 0x10E - the graphics
stack failing when PHYSICAL RAM ran out, with commit at a harmless 33-35%. The software guards
(heavy-job gate, heavy-queue, watchdog rules 7, 8 and 9) stop heavy jobs piling up. These steps are
the part only an administrator can do: a newer driver, more time for a starved driver to recover,
one less background memory user, and memory compression.

STEPS
  1. Dell Command Update: scan, then install VIDEO and CHIPSET drivers only.
  2. Longer GPU timeout: TdrDelay 2 -> 8 s, TdrDdiDelay 5 -> 20 s.
  3. Optional: uninstall Dell SupportAssist. Dell Core Services, Alienware Command Center and
     Dell Command Update stay.
  4. Turn memory compression on if it is off.
  5. Prints the Edge settings to change by hand.
#>

$ErrorActionPreference = 'Continue'
$logPath = 'C:\Users\satoh\.claude\scripts\phoenix-heavy-work-tuneup.log'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'This needs an ELEVATED window: right-click Windows PowerShell > Run as administrator, then run it again.' -ForegroundColor Red
  exit 1
}

Start-Transcript -Path $logPath -Append | Out-Null
$undo = New-Object System.Collections.Generic.List[string]

function Ask([string]$question) {
  $answer = Read-Host ("{0}  [y = yes, Enter = skip]" -f $question)
  return ($answer -match '^\s*(y|yes)\s*$')
}
function Head([string]$title) {
  Write-Host ''
  Write-Host ('==== ' + $title) -ForegroundColor Cyan
}

Write-Host ("Phoenix heavy-work tune-up, started {0} (this machine's clock, Cairo)" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# ---- STEP 1 ------------------------------------------------------------------------------------
Head 'STEP 1 of 5 - Dell Command Update: video and chipset drivers'
$dcu = 'C:\Program Files (x86)\Dell\CommandUpdate\dcu-cli.exe'
if (-not (Test-Path $dcu)) { $dcu = 'C:\Program Files\Dell\CommandUpdate\dcu-cli.exe' }
if (-not (Test-Path $dcu)) {
  Write-Host 'dcu-cli.exe was not found. Skipping; open Dell Command Update from the Start menu instead.' -ForegroundColor Yellow
} else {
  Write-Host ("Found {0}" -f $dcu)
  Write-Host 'Display adapters right now:'
  Get-CimInstance Win32_VideoController | ForEach-Object {
    Write-Host ("  {0}   driver {1}   dated {2:yyyy-MM-dd}" -f $_.Name, $_.DriverVersion, $_.DriverDate)
  }
  if (Ask 'Show dcu-cli help first, so the flags used below can be checked against this version?') {
    & $dcu '/help'
  }
  if (Ask 'Scan for updates (reads only, installs nothing)?') {
    & $dcu '/scan'
    Write-Host ("dcu-cli /scan finished, exit code {0}" -f $LASTEXITCODE)
  }
  Write-Host 'The install command is: dcu-cli /applyUpdates -updateType=driver -updateDeviceCategory=video,chipset -reboot=disable'
  if (Ask 'Install VIDEO and CHIPSET driver updates now (no automatic restart)?') {
    & $dcu '/applyUpdates' '-updateType=driver' '-updateDeviceCategory=video,chipset' '-reboot=disable'
    $dcuExit = $LASTEXITCODE
    Write-Host ("dcu-cli /applyUpdates finished, exit code {0}. 0 = installed, 1 = restart needed to finish, 500 = nothing to install." -f $dcuExit)
    if ($dcuExit -eq 0 -or $dcuExit -eq 1) {
      $undo.Add('Driver update: Device Manager > Display adapters > (the adapter) > Properties > Driver > Roll Back Driver.')
    }
  }
}

# ---- STEP 2 ------------------------------------------------------------------------------------
Head 'STEP 2 of 5 - give the graphics driver longer to recover (TDR timeout)'
$gk = 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers'
$before = Get-ItemProperty -Path $gk -ErrorAction SilentlyContinue
$oldDelay = $before.TdrDelay
$oldDdi = $before.TdrDdiDelay
Write-Host ("Now: TdrDelay={0}  TdrDdiDelay={1}  (blank = not set, Windows defaults 2 and 5 seconds)" -f $oldDelay, $oldDdi)
Write-Host 'Bugcheck 0x116 means Windows waited 2 seconds for the GPU, got no answer, and could not reset it.'
Write-Host 'When RAM is starved the driver is slow rather than dead, so a longer wait lets it come back.'
Write-Host 'This creates no memory. It only stops a slow moment becoming a bluescreen. Needs a restart.'
if (Ask 'Set TdrDelay=8 and TdrDdiDelay=20?') {
  New-ItemProperty -Path $gk -Name 'TdrDelay' -PropertyType DWord -Value 8 -Force | Out-Null
  New-ItemProperty -Path $gk -Name 'TdrDdiDelay' -PropertyType DWord -Value 20 -Force | Out-Null
  $after = Get-ItemProperty -Path $gk
  Write-Host ("Read back: TdrDelay={0}  TdrDdiDelay={1}" -f $after.TdrDelay, $after.TdrDdiDelay) -ForegroundColor Green
  if ($null -eq $oldDelay) {
    $undo.Add(("TDR delay: Remove-ItemProperty -Path '{0}' -Name TdrDelay   (then restart)" -f $gk))
  } else {
    $undo.Add(("TDR delay: Set-ItemProperty -Path '{0}' -Name TdrDelay -Value {1}   (then restart)" -f $gk, $oldDelay))
  }
  if ($null -eq $oldDdi) {
    $undo.Add(("TDR DDI delay: Remove-ItemProperty -Path '{0}' -Name TdrDdiDelay   (then restart)" -f $gk))
  } else {
    $undo.Add(("TDR DDI delay: Set-ItemProperty -Path '{0}' -Name TdrDdiDelay -Value {1}   (then restart)" -f $gk, $oldDdi))
  }
}

# ---- STEP 3 ------------------------------------------------------------------------------------
Head 'STEP 3 of 5 - OPTIONAL: uninstall Dell SupportAssist'
$uninstallRoots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$sa = @(Get-ItemProperty $uninstallRoots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Dell SupportAssist' })
if ($sa.Count -eq 0) {
  Write-Host 'Dell SupportAssist is not installed. Nothing to do.'
} else {
  foreach ($s in $sa) { Write-Host ("Found: {0} {1}   uninstall key {2}" -f $s.DisplayName, $s.DisplayVersion, $s.PSChildName) }
  Write-Host 'SupportAssist runs background scans and services that hold RAM on this 16 GB machine.'
  Write-Host 'Kept either way: Dell Core Services, Alienware Command Center (fans, lighting, power), Dell Command Update.'
  if (Ask 'Uninstall Dell SupportAssist?') {
    foreach ($s in $sa) {
      if ($s.PSChildName -match '^\{[0-9A-Fa-f-]+\}$') {
        $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList ('/x ' + $s.PSChildName + ' /qb /norestart') -Wait -PassThru
        Write-Host ("msiexec finished, exit code {0}. 0 = removed, 3010 = removed and a restart finishes it." -f $proc.ExitCode)
      } else {
        Write-Host ("That entry is not an MSI package. Remove it from Settings > Apps > Installed apps instead: {0}" -f $s.DisplayName) -ForegroundColor Yellow
      }
    }
    $undo.Add('SupportAssist: download it again from Dell''s SupportAssist page and install it.')
  }
}

# ---- STEP 4 ------------------------------------------------------------------------------------
Head 'STEP 4 of 5 - memory compression'
$mm = Get-MMAgent
Write-Host ("Now: MemoryCompression={0}  PageCombining={1}" -f $mm.MemoryCompression, $mm.PageCombining)
if ($mm.MemoryCompression) {
  Write-Host 'Already on. Nothing to do.'
} elseif (Ask 'Turn memory compression on? Windows then keeps idle pages in RAM compressed instead of writing them to the pagefile.') {
  Enable-MMAgent -MemoryCompression
  Write-Host ("Read back: MemoryCompression={0}  (fully in effect after a restart)" -f (Get-MMAgent).MemoryCompression) -ForegroundColor Green
  $undo.Add('Memory compression: Disable-MMAgent -MemoryCompression   (then restart)')
}

# ---- STEP 5 ------------------------------------------------------------------------------------
Head 'STEP 5 of 5 - Microsoft Edge, by hand (about 35 Edge processes were alive at the first crash)'
Write-Host 'Paste each address into Edge:'
Write-Host '  edge://settings/system'
Write-Host '      Startup boost: OFF'
Write-Host '      Continue running background extensions and apps when Microsoft Edge is closed: OFF'
Write-Host '  edge://settings/system/managePerformance   (older Edge: the same options sit on edge://settings/system)'
Write-Host '      Efficiency mode: ON'
Write-Host '      Save resources with sleeping tabs: ON, put inactive tabs to sleep after 5 minutes'
Write-Host '  Close tabs you are not using. Every open tab is its own process.'

# ---- DONE --------------------------------------------------------------------------------------
Head 'DONE'
if ($undo.Count -eq 0) {
  Write-Host 'Nothing was changed.'
} else {
  Write-Host 'Changes made, and how to undo each:'
  foreach ($u in $undo) { Write-Host ('  - ' + $u) }
}
Write-Host ''
Write-Host 'Restart when convenient: the driver, TDR and compression changes take effect after a restart.' -ForegroundColor Yellow
Write-Host 'Before restarting, stop dev servers and let sessions go idle. On 2026-09-11 the second crash' -ForegroundColor Yellow
Write-Host 'came four minutes after a restart, when every session started its node jobs again at once.' -ForegroundColor Yellow
Write-Host ("Transcript: {0}" -f $logPath)
Stop-Transcript | Out-Null
