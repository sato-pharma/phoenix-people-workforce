<#
.SYNOPSIS
  Runs the Phoenix visual explorer ON THE SPARE LAPTOP and copies its masked output back here, so this
  16 GB laptop starts no browser (owner, 2026-11-07: "my laptop is only 16"; the spare runs the dev
  server and the tests).

  It packs THIS checkout's scripts/phoenix-inspect/ plus the module's reviewed source files (the
  literals the masker keeps) into the spare's gitignored output/ folder, where `import "playwright"`
  and `import "bcryptjs"` still find the spare's node_modules, and runs there.

  Tasks:
    self-check      the browser checks against a local fixture page (no app, no network)
    explore         a run against STAGING (production is refused by explore.mjs itself); every further
                    argument goes to explore.mjs unchanged, e.g. --personas ceo --states summary
    plan            explore.mjs --plan: what a run would capture; no browser, no sign-in
    persona-hashes  make (or keep) the staging logins' passwords ON THE SPARE and print only their
                    bcrypt hashes; the passwords stay in the spare's %USERPROFILE%\.phoenix-inspect
    fetch <stamp>   bring back an earlier run's output whose copy did not arrive (the stamp is the
                    spare folder's name, printed by the run); nothing is run

  Exit codes: the explorer's own, or 4 when a finished run's output did not come back.

  The output comes back to artifacts\phoenix-inspection\ (gitignored). Screenshots are already masked
  on the spare; nothing unmasked crosses the network.

.EXAMPLE
  powershell -NoProfile -File scripts/phoenix-inspect/on-spare.ps1 self-check
  powershell -NoProfile -File scripts/phoenix-inspect/on-spare.ps1 explore --module kpi-reports
#>
param(
  [Parameter(Position = 0, Mandatory = $true)][ValidateSet('self-check', 'explore', 'plan', 'persona-hashes', 'fetch')][string]$Task,
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Continue'   # PS 5.1 turns a native tool's stderr into a fatal error under 'Stop'
$spareScripts = Join-Path $env:USERPROFILE '.claude\scripts'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$scpExe = "$env:SystemRoot\System32\OpenSSH\scp.exe"
$tarExe = "$env:SystemRoot\System32\tar.exe"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$minFreeMb = 1200   # a headless Chromium plus the spare's own dev server; under this the spare swaps

# The spare's address moves (the router hands it out); spare-address.ps1 finds it by its host key.
# Never write the address here.
$found = & (Join-Path $spareScripts 'spare-address.ps1')
if ($LASTEXITCODE -ne 0) { Write-Error 'the spare laptop does not answer (asleep, off, or on another network); nothing was sent'; exit 1 }
$addr = "$($found | Select-Object -Last 1)".Trim()
$target = "TransferUser@$addr"
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', '-i', $key)
function Invoke-Spare([string]$command) { & (Join-Path $spareScripts 'spare.ps1') -Command $command -ConnectTimeout 20 }

# Bring a run's output back: one archive of its out folder, unpacked under artifacts\phoenix-inspection.
# Three tries, finding the spare's address again before each retry (a dropped connection on 14 Nov 2026
# lost a finished run's copy while the run itself had succeeded). Returns $true only when files arrived;
# on failure it says where the output still is, so `fetch <stamp>` can bring it later.
function Copy-Back([string]$stamp) {
  $remoteDir = "D:/Phoenix/phoenix-workforce/output/phoenix-inspect-remote/$stamp"
  $back = Join-Path $env:TEMP "phoenix-inspect-back-$stamp.tgz"
  for ($try = 1; $try -le 3; $try++) {
    if ($try -gt 1) {
      Start-Sleep -Seconds 10
      $again = & (Join-Path $spareScripts 'spare-address.ps1')
      if ($LASTEXITCODE -eq 0) { $script:target = "TransferUser@$("$($again | Select-Object -Last 1)".Trim())" }
    }
    $packed = "$(Invoke-Spare "Set-Location '$remoteDir'; if (Test-Path out) { tar -czf back.tgz -C out .; if (`$LASTEXITCODE -eq 0) { 'packed' } else { 'pack-failed' } } else { 'no-out' }" | Select-Object -Last 1)".Trim()
    if ($packed -eq 'no-out') { Write-Host "the run wrote no output on the spare ($remoteDir)"; return $false }
    if ($packed -ne 'packed') { Write-Host "try ${try}: could not pack the output on the spare ($packed)"; continue }
    & $scpExe @sshOpts "${script:target}:$remoteDir/back.tgz" $back
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $back)) {
      $local = Join-Path $repoRoot 'artifacts\phoenix-inspection'
      New-Item -ItemType Directory -Force $local | Out-Null
      & $tarExe -xzf $back -C $local
      $unpacked = $LASTEXITCODE
      Remove-Item -LiteralPath $back -Force
      if ($unpacked -eq 0) { Write-Host "copied back to artifacts\phoenix-inspection (from the spare's $remoteDir/out)"; return $true }
    }
    Write-Host "try ${try}: the copy back did not arrive"
  }
  Write-Host "NOTHING CAME BACK after three tries; the output is still on the spare in $remoteDir/out. Bring it with: on-spare.ps1 fetch $stamp"
  return $false
}

# fetch <stamp>: bring back an earlier run's output that did not arrive; nothing is run or sent.
if ($Task -eq 'fetch') {
  $from = "$($Rest | Select-Object -First 1)"
  if ($from -notmatch '^\d{8}-\d{6}$') { Write-Error 'fetch needs the stamp of the spare folder, e.g. 20261114-191254'; exit 1 }
  if (Copy-Back $from) { exit 0 } else { exit 4 }
}

# Free memory on the spare, read live.
$freeMb = "$(Invoke-Spare '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)' | Select-Object -Last 1)".Trim()
if (-not ($freeMb -match '^\d+$')) { Write-Error "could not read the spare's free memory ('$freeMb'); nothing was sent"; exit 1 }
"spare at $addr, $freeMb MB free"
if ([int]$freeMb -lt $minFreeMb -and $Task -ne 'persona-hashes' -and $Task -ne 'plan') {
  Write-Error "the spare has $freeMb MB free (needs $minFreeMb); nothing was started"; exit 1
}

# Pack: the explorer itself plus the module's reviewed source files, at their repo paths.
$sources = & node --input-type=module -e "import('file:///' + process.argv[1].replace(/\\/g, '/')).then((m) => console.log(m.SOURCE_FILES.join('\n')))" (Join-Path $repoRoot 'scripts\phoenix-inspect\modules\kpis.mjs')
if ($LASTEXITCODE -ne 0 -or -not $sources) { Write-Error 'could not read the module source list'; exit 1 }
# The commit the packed source files come from, marked +dirty when any of them differs from it, so every
# screenshot's source mapping names the code it was read from (the manifest's sourceCommit).
$sourceCommit = "$(& git -C $repoRoot rev-parse HEAD)".Trim()
& git -C $repoRoot diff --quiet HEAD -- @($sources | Where-Object { $_ })
if ($LASTEXITCODE -ne 0) { $sourceCommit = "$sourceCommit+dirty" }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$pack = Join-Path $env:TEMP "phoenix-inspect-$stamp.tgz"
$list = Join-Path $env:TEMP "phoenix-inspect-$stamp.txt"
# scripts/lib/refuse-arguments.mjs is the repo's shared unknown-flag gate the explorer's scripts import.
$entries = @('scripts/phoenix-inspect', 'scripts/lib/refuse-arguments.mjs') + @($sources | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $repoRoot $_)) })
[IO.File]::WriteAllLines($list, [string[]]$entries)
Push-Location $repoRoot
& $tarExe -czf $pack -T $list
$tarCode = $LASTEXITCODE
Pop-Location
Remove-Item -LiteralPath $list -Force
if ($tarCode -ne 0) { Write-Error 'could not pack the explorer'; exit 1 }

$remoteDir = "D:/Phoenix/phoenix-workforce/output/phoenix-inspect-remote/$stamp"
Invoke-Spare "New-Item -ItemType Directory -Force '$remoteDir' | Out-Null"
& $scpExe @sshOpts $pack "${target}:$remoteDir/pack.tgz"
$scpCode = $LASTEXITCODE
Remove-Item -LiteralPath $pack -Force
if ($scpCode -ne 0) { Write-Error 'could not copy the explorer to the spare laptop'; exit 1 }

# Each argument goes over single-quoted, so spaces and $ survive the trip.
$quoted = ($Rest | Where-Object { $_ } | ForEach-Object { "'" + ([string]$_).Replace("'", "''") + "'" }) -join ' '
switch ($Task) {
  'self-check' { $run = "node scripts/phoenix-inspect/self-check.mjs --out '$remoteDir/out/self-check' $quoted" }
  'explore' { $run = "node scripts/phoenix-inspect/explore.mjs --out '$remoteDir/out' --source-commit '$sourceCommit' $quoted" }
  'plan' { $run = "node scripts/phoenix-inspect/explore.mjs --plan $quoted" }
  'persona-hashes' { $run = "node scripts/phoenix-inspect/make-persona-secrets.mjs $quoted" }
}
$remote = @"
Set-Location '$remoteDir'
tar -xzf pack.tgz
if (`$LASTEXITCODE) { 'could not unpack on the spare'; exit 9 }
$run 2>&1 | ForEach-Object { "`$_" }
exit `$LASTEXITCODE
"@
Invoke-Spare $remote
$code = $LASTEXITCODE

if ($Task -eq 'self-check' -or $Task -eq 'explore') {
  if (-not (Copy-Back $stamp)) { exit 4 }
}
exit $code
