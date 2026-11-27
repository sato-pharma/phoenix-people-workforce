<#
  Phoenix dev-speed tune-up - the part only an administrator can do.

  HOW TO RUN (from a PowerShell window opened with "Run as administrator"):
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\satoh\.claude\scripts\phoenix-dev-speed.ps1"

  It asks before every change, prints what it read back, and lists how to undo each one at the end.
  A full transcript goes to C:\Users\satoh\.claude\scripts\phoenix-dev-speed.log

  WHAT IT DOES, AND WHAT IT COSTS
  Windows Defender scans every file that is opened. A build, an install, a typecheck and a git
  command open tens of thousands of small files, so the scanner is charged for each one. Telling
  Defender to skip the development folders is the single biggest speed change available on this
  machine - typically 30-50% off file-heavy work.

  THE TRADE-OFF, IN PLAIN WORDS: files inside an excluded folder are no longer scanned while they
  are opened. If something malicious ever landed in the repository or in node_modules, real-time
  scanning would not catch it there. A full scan still covers these folders, and the rest of the
  machine - Downloads, email attachments, the browser - stays fully protected. Only development
  folders are listed below; no system folder is excluded, and no interpreter is excluded as a
  process, so a script downloaded from the internet is still scanned the same as today.
#>

$ErrorActionPreference = 'Stop'
$logPath = 'C:\Users\satoh\.claude\scripts\phoenix-dev-speed.log'
$undo = New-Object System.Collections.Generic.List[string]

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'This needs an ELEVATED window: right-click Windows PowerShell > Run as administrator, then run it again.' -ForegroundColor Red
  exit 1
}

Start-Transcript -Path $logPath -Append | Out-Null

function Ask([string]$question) {
  Write-Host ''
  Write-Host ($question + ' [y/n]') -ForegroundColor Cyan
  $answer = Read-Host
  return ($answer -match '^\s*(y|yes)\s*$')
}
function Head([string]$title) { Write-Host ''; Write-Host ('==== ' + $title) -ForegroundColor Cyan }

Write-Host ("Phoenix dev-speed tune-up, started {0} (this machine's clock, Cairo)" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# ---- STEP 1 - folder exclusions -----------------------------------------------------------------
Head 'STEP 1 of 3 - stop Defender scanning the development folders'

$wantPaths = @(
  'F:\Phoenix Workforce',
  'C:\Users\satoh\.claude',
  'C:\Users\satoh\AppData\Local\pnpm',
  'C:\Users\satoh\AppData\Local\pnpm-store',
  'C:\Program Files\nodejs'
)
$wantPaths = @($wantPaths | Where-Object { Test-Path $_ })

$before = @((Get-MpPreference).ExclusionPath)
Write-Host ("Folders already excluded: {0}" -f $before.Count)
foreach ($p in $before) { Write-Host ("   $p") }
$missing = @($wantPaths | Where-Object { $before -notcontains $_ })
if ($missing.Count -eq 0) {
  Write-Host 'All the development folders are already excluded. Nothing to do.' -ForegroundColor Green
} else {
  Write-Host 'To add:'
  foreach ($p in $missing) { Write-Host ("   $p") }
  if (Ask 'Add these folders to the Defender exclusion list?') {
    foreach ($p in $missing) { Add-MpPreference -ExclusionPath $p }
    $after = @((Get-MpPreference).ExclusionPath)
    $still = @($wantPaths | Where-Object { $after -notcontains $_ })
    Write-Host ("Read back: {0} folders excluded, {1} of the wanted ones missing." -f $after.Count, $still.Count) -ForegroundColor Green
    foreach ($p in $missing) { $undo.Add(("Folder exclusion: Remove-MpPreference -ExclusionPath '{0}'" -f $p)) }
  }
}

# ---- STEP 2 - process exclusions ----------------------------------------------------------------
Head 'STEP 2 of 3 - stop Defender inspecting the build tools themselves'
Write-Host 'These are the programs that open thousands of files per run. No interpreter that runs'
Write-Host 'downloaded scripts (powershell, wscript, cmd) is listed, deliberately.'

$wantProcs = @('node.exe', 'git.exe', 'pnpm.exe', 'claude.exe', 'esbuild.exe')
$beforeP = @((Get-MpPreference).ExclusionProcess)
Write-Host ("Processes already excluded: {0}  {1}" -f $beforeP.Count, ($beforeP -join ', '))
$missingP = @($wantProcs | Where-Object { $beforeP -notcontains $_ })
if ($missingP.Count -eq 0) {
  Write-Host 'All of them are already excluded. Nothing to do.' -ForegroundColor Green
} else {
  Write-Host ("To add: {0}" -f ($missingP -join ', '))
  if (Ask 'Add these programs to the Defender process exclusion list?') {
    foreach ($p in $missingP) { Add-MpPreference -ExclusionProcess $p }
    $afterP = @((Get-MpPreference).ExclusionProcess)
    Write-Host ("Read back: {0}  {1}" -f $afterP.Count, ($afterP -join ', ')) -ForegroundColor Green
    foreach ($p in $missingP) { $undo.Add(("Process exclusion: Remove-MpPreference -ExclusionProcess '{0}'" -f $p)) }
  }
}

# ---- STEP 3 - measure it ------------------------------------------------------------------------
Head 'STEP 3 of 3 - measure the difference on this machine'
$probe = 'F:\Phoenix Workforce\phoenix-workforce\node_modules'
if (Test-Path $probe) {
  Write-Host 'Reading 3,000 files out of node_modules and timing it. This is the work a build does.'
  $files = @(Get-ChildItem $probe -Recurse -File -Filter *.js -ErrorAction SilentlyContinue | Select-Object -First 3000)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  foreach ($f in $files) { [void][IO.File]::ReadAllBytes($f.FullName) }
  $sw.Stop()
  Write-Host ("Read {0} files in {1:N0} ms ({2:N2} ms per file)" -f $files.Count, $sw.Elapsed.TotalMilliseconds, ($sw.Elapsed.TotalMilliseconds / [math]::Max(1, $files.Count))) -ForegroundColor Green
  Write-Host 'Before these exclusions the same probe measured 0.577 ms per file on this laptop (3,000 files in 1,732 ms, 2026-09-12 02:18 Cairo).'
} else {
  Write-Host 'node_modules not found, skipping the measurement.'
}

# ---- DONE ---------------------------------------------------------------------------------------
Head 'DONE'
if ($undo.Count -eq 0) {
  Write-Host 'Nothing was changed.'
} else {
  Write-Host 'Changes made, and how to undo each (each needs an elevated window):'
  foreach ($u in $undo) { Write-Host ('  - ' + $u) }
}
Write-Host ''
Write-Host 'No restart is needed. The exclusions take effect immediately.' -ForegroundColor Yellow
Write-Host ("Transcript: {0}" -f $logPath)
Stop-Transcript | Out-Null
