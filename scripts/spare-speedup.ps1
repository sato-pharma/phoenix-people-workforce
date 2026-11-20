throw 'WINDOWS-ONLY-RETIRED: the spare runs Ubuntu Server since 20 Nov 2026 (owner: "put Ubuntu Server on the spare"). This script drove its Windows and must not run against Linux. Use spare.ps1 (bash), spare-test.ps1, spare-follow-production.ps1.'
# Phoenix spare laptop - DEV SERVER SPEED-UP (owner 2026-11-20: "I want the dev server to be super fast. Use all resources of the other laptop.")
# Paste ONCE into Windows PowerShell opened with "Run as administrator" ON THE SPARE LAPTOP. Safe to run again. Restarts the spare at the end.
# These are antivirus, power and startup settings, so they are run by the owner's own paste, never remotely.
$ErrorActionPreference = 'Stop'; $step = 'start'
function Say($m) { Write-Host $m -ForegroundColor Cyan }
try {
  $step = 'checking this window is "Run as administrator"'
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'this window is not "Run as administrator". Right-click Start, choose "Terminal (Admin)", and paste again.' }

  # 1. The biggest one: the antivirus scans every file webpack reads and writes (about 100,000 in node_modules and .next).
  #    Only the code and package folders are skipped; real-time protection stays ON for everything else.
  $step = 'telling the antivirus to skip the code folders'
  Say '1/5 Antivirus: skipping the code and package folders (protection stays on everywhere else)...'
  $paths = @('D:\Phoenix', 'D:\.pnpm-store', "$env:LOCALAPPDATA\pnpm", "$env:APPDATA\npm", "$env:APPDATA\npm-cache")
  Add-MpPreference -ExclusionPath $paths

  # 2. Full speed on the charger: the "High performance" plan (the CPU stops stepping down between compiles).
  $step = 'switching to full speed on the charger'
  Say '2/5 Power: full speed on the charger...'
  $hp = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
  $plans = "$(powercfg /list)"
  if ($plans -notmatch $hp) { powercfg -duplicatescheme $hp $hp | Out-Null }
  powercfg /setactive $hp
  powercfg /change standby-timeout-ac 0; powercfg /change hibernate-timeout-ac 0; powercfg /change monitor-timeout-ac 10
  powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMIN 100
  powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
  powercfg /setactive SCHEME_CURRENT

  # 3. Give the memory to the dev server: the spare has 7.7 GB and the dev server legitimately grows to ~6 GB.
  $step = 'freeing memory for the dev server'
  Say '3/5 Memory: closing Edge and OneDrive, stopping them from starting with Windows...'
  foreach ($n in 'msedge', 'OneDrive', 'AsusMyASUS', 'SystemSettings') { Get-Process $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
  $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  (Get-Item $run).Property | Where-Object { $_ -eq 'OneDrive' -or $_ -like 'MicrosoftEdgeAutoLaunch*' } | ForEach-Object { Remove-ItemProperty -Path $run -Name $_ }
  $edge = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
  if (-not (Test-Path $edge)) { New-Item -Path $edge -Force | Out-Null }
  New-ItemProperty -Path $edge -Name StartupBoostEnabled -Value 0 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $edge -Name BackgroundModeEnabled -Value 0 -PropertyType DWord -Force | Out-Null

  # 4. Search indexing re-reads every changed file in the checkout after each update; this laptop is a server, nobody searches on it.
  $step = 'switching off search indexing'
  Say '4/5 Search indexing: off...'
  Stop-Service WSearch -Force -ErrorAction SilentlyContinue; Set-Service WSearch -StartupType Disabled

  # 5. Room to grow: a fixed 12 GB page file on the fast SSD, so the dev server never runs out of memory at its peak.
  $step = 'setting the page file'
  Say '5/5 Page file: 12 GB on the SSD (takes effect at the next restart)...'
  $cs = Get-CimInstance Win32_ComputerSystem
  if ($cs.AutomaticManagedPagefile) { Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false } }
  $pf = Get-CimInstance Win32_PageFileSetting -Filter "Name='C:\\pagefile.sys'"
  if ($pf) { Set-CimInstance -InputObject $pf -Property @{ InitialSize = 12288; MaximumSize = 12288 } }
  else { New-CimInstance -ClassName Win32_PageFileSetting -Property @{ Name = 'C:\pagefile.sys'; InitialSize = [uint32]12288; MaximumSize = [uint32]12288 } | Out-Null }

  "speedup v1 $(Get-Date -Format s)" | Set-Content "$env:ProgramData\ssh\phx-speedup-ok.txt" -Encoding ascii
  $free = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
  Write-Host ''
  Write-Host "OK - the spare is tuned for the dev server ($free MB free now)." -ForegroundColor Green
  Write-Host 'It RESTARTS in 30 seconds so the page file takes effect; the dev server starts and warms up by itself.' -ForegroundColor Yellow
  Start-Sleep 30
  Restart-Computer -Force
} catch { Write-Host "NOT OK - it stopped while $step." -ForegroundColor Red; Write-Host $_.Exception.Message -ForegroundColor Red; Write-Host 'Take a photo of this window.' -ForegroundColor Red }
