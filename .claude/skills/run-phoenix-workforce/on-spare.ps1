<#
.SYNOPSIS
  Runs driver.mjs ON THE SPARE LAPTOP against its own dev server, then copies the screenshots back
  to output/run-skill/ here. The main laptop starts no browser and no server, so it stays lean
  (owner, 2026-11-07: "my laptop is only 16"; the spare runs the dev server and the tests).

  It sends THIS checkout's driver.mjs (so a driver fix is tested before it merges) into the spare's
  gitignored output/ folder, where `import "playwright"` still finds the spare's node_modules.
  Every argument is passed to the driver unchanged; --timeout defaults to 900 s because the spare
  compiles a page it has not served yet in up to ~10 minutes.

  The spare's dev server runs PRODUCTION's exact version on the production database: a run shows
  what is live, never your branch.

.EXAMPLE
  powershell -NoProfile -File .claude/skills/run-phoenix-workforce/on-spare.ps1 --role "Super Admin" go /admin shot admin overflow
#>
$ErrorActionPreference = 'Continue'   # PS 5.1 turns remote stderr into a fatal error under 'Stop'
if ($args.Count -eq 0) { Write-Error 'no steps. e.g.: --role "Super Admin" go /admin shot admin'; exit 2 }
$spareScripts = Join-Path $env:USERPROFILE '.claude\scripts'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$spare = 'TransferUser@192.168.1.60'
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', '-i', $key)
$scpExe = "$env:SystemRoot\System32\OpenSSH\scp.exe"

# A wedged server only gets worse with another request queued behind it: read healthz first, through
# the tunnel ("Phoenix Spare Tunnel" forwards local 3000 to the spare's 3000).
try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 http://localhost:3000/api/healthz }
catch { Write-Error "the spare's dev server does not answer /api/healthz in 60 s ($($_.Exception.Message)) - it is compiling or out of memory; nothing was sent"; exit 1 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$remoteDir = "D:/Phoenix/phoenix-workforce/output/run-skill-remote/$stamp"
& "$spareScripts\spare.ps1" -Command "New-Item -ItemType Directory -Force '$remoteDir' | Out-Null" -ConnectTimeout 20
& $scpExe @sshOpts (Join-Path $PSScriptRoot 'driver.mjs') "${spare}:$remoteDir/driver.mjs"
if ($LASTEXITCODE) { Write-Error 'could not copy driver.mjs to the spare laptop'; exit 1 }

# Each argument goes over single-quoted, so spaces ("Super Admin") and $ survive the trip.
$quoted = ($args | ForEach-Object { "'" + ([string]$_).Replace("'", "''") + "'" }) -join ' '
$hasTimeout = $args -contains '--timeout'
$prefix = if ($hasTimeout) { '' } else { "'--timeout' '900' " }
$remote = @"
Set-Location D:\Phoenix\phoenix-workforce
node '$remoteDir/driver.mjs' $prefix'--out' '$remoteDir' $quoted 2>&1 | ForEach-Object { "`$_" }
exit `$LASTEXITCODE
"@
& "$spareScripts\spare.ps1" -Command $remote -ConnectTimeout 20
$code = $LASTEXITCODE

$local = Join-Path (Get-Location) 'output\run-skill'
New-Item -ItemType Directory -Force $local | Out-Null
$names = & "$spareScripts\spare.ps1" -Command "Get-ChildItem '$remoteDir' -Filter *.png -Name" -ConnectTimeout 20
foreach ($name in @($names | Where-Object { $_ -like '*.png' })) {
  & $scpExe @sshOpts "${spare}:$remoteDir/$name" (Join-Path $local $name)
  if (-not $LASTEXITCODE) { "copied back: output\run-skill\$name" }
}
exit $code
