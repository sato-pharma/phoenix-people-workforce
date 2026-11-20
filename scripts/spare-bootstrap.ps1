throw 'WINDOWS-ONLY-RETIRED: the spare runs Ubuntu Server since 20 Nov 2026 (owner: "put Ubuntu Server on the spare"). This script drove its Windows and must not run against Linux. Use spare.ps1 (bash), spare-test.ps1, spare-follow-production.ps1.'
# Phoenix spare laptop - REBUILD AFTER A FRESH WINDOWS (v4.1,owner 2026-11-20: "I reinstalled its Windows ... I hate manual work. Automate.")
# Paste ONCE into Windows PowerShell opened with "Run as administrator" ON THE SPARE LAPTOP. Safe to run again.
# It installs remote login (key only, home network only), Git, Node.js 24 and pnpm, keeps the laptop awake on the charger,
# then RESTARTS the laptop. The main laptop's "Phoenix Spare Rebuild" task finds it afterwards and does everything else.
# Source of truth: ~/.claude/scripts/spare-bootstrap.ps1 on the main laptop; the private page shows the same text.
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $step = 'start'
function Say($m) { Write-Host $m -ForegroundColor Cyan }
try {
  $step = 'checking this window is "Run as administrator"'
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'this window is not "Run as administrator". Close it, right-click Start, choose "Terminal (Admin)", and paste again.' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHRUP2u1kNY17hiznTPskfqstItmOgeyd/In33RPxOLj phoenix-main-to-spare'
  $winget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
  $needRestart = $false   # v4.1: restart only when this run installed something, so a second paste never interrupts work

  # 1. Remote login. Add-WindowsCapability hung once (2026-11-07, Windows Update download), so it gets 5 minutes, then winget.
  $step = 'installing remote login'
  if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
    Say '1/6 Installing remote login (up to 5 minutes)...'; $needRestart = $true
    $job = Start-Job { Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' }
    if (-not (Wait-Job $job -Timeout 300)) { Stop-Job $job }
    Remove-Job $job -Force
    if (-not (Get-Service sshd -ErrorAction SilentlyContinue) -and $winget) {
      winget install --id Microsoft.OpenSSH.Preview -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
    }
    if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { throw 'remote login did not install' }
  } else { Say '1/6 Remote login already installed' }
  $step = 'setting up remote login'
  Set-Service sshd -StartupType Automatic; Start-Service sshd; Start-Sleep 2   # the first start writes sshd_config and the host keys
  $cfg = "$env:ProgramData\ssh\sshd_config"
  $c = @('PasswordAuthentication no', 'Banner __PROGRAMDATA__/ssh/phx-banner.txt') + @(Get-Content $cfg | Where-Object { $_ -notmatch '^\s*#?\s*(PasswordAuthentication|Banner)\b' })
  $cfgChanged = ((Get-Content $cfg) -join "`n") -ne ($c -join "`n")
  if ($cfgChanged) { Set-Content $cfg $c -Encoding ascii }
  # The banner is shown BEFORE sign-in: the main laptop reads the user name and the marker from it to find this laptop.
  "phx-user=$env:USERNAME phx-spare=4" | Set-Content "$env:ProgramData\ssh\phx-banner.txt" -Encoding ascii
  $ak = "$env:ProgramData\ssh\administrators_authorized_keys"; Set-Content $ak $key -Encoding ascii
  icacls $ak /inheritance:r /grant "*S-1-5-32-544:F" /grant "*S-1-5-18:F" | Out-Null
  New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null; Set-Content "$env:USERPROFILE\.ssh\authorized_keys" $key -Encoding ascii
  if (-not (Test-Path 'HKLM:\SOFTWARE\OpenSSH')) { New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' | Out-Null }
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
  Get-NetFirewallRule -Name 'PhoenixSpareSSH' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -Name 'PhoenixSpareSSH' -DisplayName 'Phoenix main laptop remote login' -Protocol TCP -LocalPort 22 -Direction Inbound -Action Allow -RemoteAddress LocalSubnet -Profile Any | Out-Null
  if ($cfgChanged) { Restart-Service sshd }   # v4.1: a second paste leaves the main laptop's running sessions alone

  # 2. Git
  $step = 'installing Git'
  $gitExe = "$env:ProgramFiles\Git\cmd\git.exe"
  if (-not (Test-Path $gitExe)) {
    Say '2/6 Installing Git...'; $needRestart = $true
    if ($winget) { winget install --id Git.Git -e --silent --scope machine --accept-source-agreements --accept-package-agreements | Out-Null }
    if (-not (Test-Path $gitExe)) {
      $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'phoenix-spare-setup' }
      $asset = $rel.assets | Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' } | Select-Object -First 1
      $exe = Join-Path $env:TEMP $asset.name
      Invoke-WebRequest $asset.browser_download_url -OutFile $exe -UseBasicParsing
      Start-Process $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES' -Wait
    }
    if (-not (Test-Path $gitExe)) { throw 'Git did not install' }
  } else { Say '2/6 Git already installed' }
  & $gitExe config --system core.longpaths true
  & $gitExe config --system --replace-all safe.directory '*'   # D:\ survived the reinstall but its files belong to the OLD Windows user

  # 3. Node.js 24 (the version the spare ran; nodejs.org's own installer, checked against its published checksum)
  $step = 'installing Node.js 24'
  $nodeExe = "$env:ProgramFiles\nodejs\node.exe"
  $have = if (Test-Path $nodeExe) { "$(& $nodeExe -v)" } else { '' }
  if ($have -notmatch '^v24\.') {
    Say '3/6 Installing Node.js 24...'; $needRestart = $true
    $base = 'https://nodejs.org/dist/latest-v24.x/'
    $sums = "$((Invoke-WebRequest "${base}SHASUMS256.txt" -UseBasicParsing).Content)"
    $line = ($sums -split "`n") | Where-Object { $_ -match 'node-v24\.[\d.]+-x64\.msi\s*$' } | Select-Object -First 1
    $hash, $name = $line.Trim() -split '\s+'
    $msi = Join-Path $env:TEMP $name
    Invoke-WebRequest "$base$name" -OutFile $msi -UseBasicParsing
    if ((Get-FileHash $msi -Algorithm SHA256).Hash -ne $hash) { throw 'the Node.js download did not match its checksum' }
    $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait -PassThru
    if (-not (Test-Path $nodeExe)) { throw "Node.js did not install (installer exit $($p.ExitCode))" }
  } else { Say "3/6 Node.js $have already installed" }

  # 4. pnpm, the version the project names
  $step = 'installing pnpm'
  Say '4/6 Installing pnpm 11.13.1...'
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:APPDATA\npm"
  # v4.1 (2026-11-20): npm writes "npm notice" to stderr, and Windows PowerShell 5.1 under 'Stop' turns a redirected stderr line
  # into a fatal error - the first run stopped here on exactly that. npm runs in its own process; its exit code and the file decide.
  $out = Join-Path $env:TEMP 'pnpm-install-out.log'; $err = Join-Path $env:TEMP 'pnpm-install-err.log'
  $p = Start-Process "$env:ProgramFiles\nodejs\npm.cmd" -ArgumentList 'install', '-g', 'pnpm@11.13.1', '--no-fund', '--no-audit' -Wait -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
  if (-not (Test-Path "$env:APPDATA\npm\pnpm.cmd")) { throw "pnpm did not install (npm exit $($p.ExitCode)): " + ((Get-Content $err -Tail 3 -ErrorAction SilentlyContinue) -join ' / ') }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$env:APPDATA\npm*") { [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$env:APPDATA\npm").TrimStart(';'), 'User') }

  # 5. The D:\Phoenix folder every spare script uses. A second disk or partition keeps its D: letter; with no D: at all,
  #    D: is made a permanent name for C:\PhoenixDrive (it takes effect at the restart below).
  $step = 'preparing D:\Phoenix'
  $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='D:'"
  if (-not $d) {
    New-Item -ItemType Directory -Force 'C:\PhoenixDrive\Phoenix\inbox' | Out-Null
    New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\DOS Devices' -Name 'D:' -Value '\??\C:\PhoenixDrive' -PropertyType String -Force | Out-Null
    $dNote = 'D: is now a name for C:\PhoenixDrive (no second disk was found)'; $needRestart = $true
  } elseif ($d.DriveType -ne 3) {
    throw "D: is a CD or USB drive here. Give it another letter in Disk Management, then paste this again."
  } else {
    New-Item -ItemType Directory -Force 'D:\Phoenix\inbox' | Out-Null
    $dNote = if (Test-Path 'D:\Phoenix\phoenix-workforce\.git') { 'D:\Phoenix\phoenix-workforce survived the reinstall and is kept' } else { 'D:\Phoenix is ready; the main laptop sends the code' }
  }

  # 6. Stay awake on the charger, lid closed included (it serves the dev server and the tests all day)
  $step = 'keeping the laptop awake on the charger'
  Say '5/6 Keeping the laptop awake on the charger...'
  powercfg /change standby-timeout-ac 0; powercfg /change hibernate-timeout-ac 0; powercfg /change monitor-timeout-ac 10
  powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0; powercfg /setactive SCHEME_CURRENT

  "v4.1 $(Get-Date -Format s) user=$env:USERNAME" | Set-Content "$env:ProgramData\ssh\phx-setup-ok.txt" -Encoding ascii
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' } | Select-Object -First 1).IPAddress
  Write-Host ''
  Write-Host "OK - the spare is set up (user $env:USERNAME, address $ip). $dNote." -ForegroundColor Green
  Write-Host 'Leave it on the charger and on the home Wi-Fi. The main laptop finishes the rest by itself.' -ForegroundColor Green
  if ($needRestart) {
    Write-Host '6/6 The laptop RESTARTS in 30 seconds so the new programs take effect...' -ForegroundColor Yellow
    Start-Sleep 30
    Restart-Computer -Force
  } else { Write-Host '6/6 Nothing new was installed, so no restart is needed. You can close this window.' -ForegroundColor Green }
} catch { Write-Host "NOT OK - it stopped while $step." -ForegroundColor Red; Write-Host $_.Exception.Message -ForegroundColor Red; Write-Host 'Take a photo of this window.' -ForegroundColor Red }
