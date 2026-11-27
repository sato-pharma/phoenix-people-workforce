<#
  phx-live.ps1 - your Phoenix on the Hetzner box at http://localhost:3000, running MAIN.

  MAIN ONLY (owner, 2026-10-17: "I want the PHX live to always run on main. Any update I will do, I
  will push to main and test on main, never on any branch."). The box serves GitHub's main and moves
  with it by itself: a merge reaches localhost:3000 about 3-4 minutes later, while the previous build
  keeps answering. No laptop folder, branch or unpushed edit ever reaches it - -Folder is refused.
  A branch or a worktree is looked at with the laptop's own `pnpm run dev` in that folder.
    phx-live         PRODUCTION BUILD of main: every page as fast as the real site. The minimised
                     follow window says "SERVING main <sha> - reload the page" when a merge is in.
    phx-live -Dev    `next dev` of main: a page's first open compiles it (10-30 s), then 1-3 s.
                     What /admin/dev-preview needs.
    phx-live -DevAuth  `next dev` of main that also accepts x-phoenix-role headers (role sweeps).
    phx-live -Build  accepted and ignored - the production build is the default.
  History: `next dev` was the default from the morning of 2026-10-17 until main-only the same evening;
  its one advantage, a SAVE showing in seconds, does not exist when nothing is edited on the box.

  !! THIS IS PRODUCTION DATA. Every write is real. Emails and notifications are NOT sent - and one
  started from here is lost for good (marked skipped), so approve / publish / nudge on the real site.
  Every page carries a red PRODUCTION DATA strip so you can tell the tab apart.
  The full list of drawbacks and how each is handled: docs/agents-worktree-and-machine-limits.md, "phx-live".

  HOW IT WORKS
    GitHub main --phx-live-follow.mjs (every 60 s)--> ssh as phx: live-ctl.sh follow <sha>
    browser localhost:3000 --ssh tunnel as phxtunnel (127.0.0.1:3100 only)--> the server on the box
    The box caps the server at 7 GB and stops it after 60 idle minutes. This laptop runs ssh and one
    small node process - no dev server, no build. (phx-live-sync.mjs, the old folder mirror, is kept
    for history and no longer started.)

  USAGE
    phx-live                              # main, production build, open localhost:3000
    phx-live -Dev                         # main under next dev
    phx-live -DevAuth                     # main under next dev with x-phoenix-role headers (role sweeps)
    phx-live -Resync                      # re-install the box at main from scratch
    phx-live -Stop                        # stop the follow window, the tunnel and the box server
    phx-live -InstallEnv                  # one time: send the allowlisted keys from the main folder's .env.local
    phx-live -InstallEnvStaging           # use the box's STAGING keys instead (testing)
    phx-live -LocalPort 3005              # if localhost:3000 is taken
#>
param(
  [string]$Folder = "",
  [int]$LocalPort = 3000,
  [switch]$Dev,
  [switch]$Build,
  [switch]$DevAuth,
  [switch]$Resync,
  [switch]$Stop,
  [switch]$InstallEnv,
  [switch]$InstallEnvStaging,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$BoxHost = "46.225.184.142"
$Key     = Join-Path $env:USERPROFILE ".ssh\railway_phoenix_ed25519"
$Follow  = Join-Path $env:USERPROFILE ".claude\scripts\phx-live-follow.mjs"
$Repo    = "Gawish-1997/phoenix-people-workforce"
# The ONE folder phx-live still reads: -InstallEnv takes the production keys from its .env.local.
$EnvFolder = "F:\Phoenix Workforce\phoenix-workforce"
$SshOpts = @("-i", $Key, "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes",
             "-o", "ConnectTimeout=20", "-o", "LogLevel=ERROR")

function Write-Step($msg) { Write-Host "  $msg" }
function Invoke-Ctl($sub) { & ssh @SshOpts "phx@$BoxHost" "bash /home/phx/live-ctl.sh $sub 2>&1" }

if (-not (Test-Path $Key)) { Write-Host "SSH key not found: $Key" -ForegroundColor Red; exit 1 }

function Stop-Tunnel($port) {
  $n = 0
  Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*-L ${port}:127.0.0.1:3100*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
  return $n
}
# The follow window, and any old folder-sync window still open from before main-only.
function Stop-Sync {
  $n = 0
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*phx-live-sync.mjs*" -or $_.CommandLine -like "*phx-live-follow.mjs*") -and
                   $_.CommandLine -notlike "*--print-base*" -and $_.CommandLine -notlike "*--print-main*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
  return $n
}

# ---- -Stop ---------------------------------------------------------------------------------
if ($Stop) {
  Write-Host "Stopping phx-live" -ForegroundColor Cyan
  Write-Step "follow windows closed: $(Stop-Sync)"
  Write-Step "tunnels closed: $(Stop-Tunnel $LocalPort)"
  Invoke-Ctl "stop" | ForEach-Object { Write-Step $_ }
  exit 0
}

# ---- -InstallEnv / -InstallEnvStaging ------------------------------------------------------
if ($InstallEnvStaging) {
  Invoke-Ctl "install-env-staging" | ForEach-Object { Write-Step $_ }
  exit 0
}
if ($InstallEnv) {
  $envFile = Join-Path $EnvFolder ".env.local"
  if (-not (Test-Path $envFile)) { Write-Host "No .env.local in $EnvFolder" -ForegroundColor Red; exit 1 }
  Write-Host "Sending the allowlisted keys from $envFile (the box drops every other key)" -ForegroundColor Cyan
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  Get-Content -LiteralPath $envFile -Raw | & ssh @SshOpts "phx@$BoxHost" "bash /home/phx/live-ctl.sh install-env 2>&1" |
    ForEach-Object { Write-Step $_ }
  # A RUNNING server still holds the OLD keys - next reads its env once, at start. Leaving it up
  # would show you staging data from a box you just pointed at production, which is the worst
  # possible way to be wrong. Stop it, so the next start is the new env.
  Invoke-Ctl "stop" | ForEach-Object { Write-Step $_ }
  Write-Host "  Now run:  phx-live" -ForegroundColor Yellow
  exit 0
}

# MAIN ONLY (owner, 2026-10-17). A folder, branch or worktree is never served from here.
if ($Folder) {
  Write-Host "  phx-live runs MAIN only (owner, 2026-10-17: `"always run on main ... never on any branch`")." -ForegroundColor Red
  Write-Host "  To look at a branch or a worktree, run  pnpm run dev  in that folder on this laptop." -ForegroundColor Yellow
  exit 1
}

# The production build is the default (main-only, 2026-10-17); dev-auth headers and /admin/dev-preview
# only work under next dev, so -Dev and -DevAuth ask for it. -Build is accepted and ignored.
$Mode = if ($Dev -or $DevAuth) { "dev" } else { "fast" }

Write-Host "phx-live - your Phoenix on the Hetzner box, PRODUCTION data" -ForegroundColor Cyan
Write-Step "branch      : main on GitHub - every merge reaches it by itself"
Write-Step "local port  : $LocalPort"
Write-Step ("mode        : " + $(if ($Mode -eq "fast") { "production build - fast pages, a merge shows after a rebuild (about 3-4 min)" } else { "next dev - a page's first open compiles it (10-30 s), then 1-3 s" }))
Write-Step ("dev-auth    : " + $(if ($DevAuth) { "ON - any x-phoenix-role header is accepted" } else { "off" }))

# ---- 1. safety checks ------------------------------------------------------------------------
$selfHosted = (& gh variable get CI_SELF_HOSTED -R $Repo 2>$null)
if ("$selfHosted".Trim() -ne "off") {
  Write-Host "  CI_SELF_HOSTED is '$selfHosted', not 'off'. The runner runs as phx (sudo) and could read the" -ForegroundColor Red
  Write-Host "  production keys, so phx-live will not start while it is on." -ForegroundColor Red
  exit 1
}
$busy = Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue
if ($busy) {
  if ((Stop-Tunnel $LocalPort) -eq 0) {
    $owner = (Get-Process -Id $busy[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
    Write-Host "  localhost:$LocalPort is in use by $owner (pid $($busy[0].OwningProcess))." -ForegroundColor Red
    Write-Host "  Stop it, or run:  phx-live -LocalPort 3005" -ForegroundColor Yellow
    exit 1
  }
  Start-Sleep -Seconds 1
}
[void](Stop-Sync)

# ---- 2. put the box at the right base, and start its server ----------------------------------
$base = "$(& node $Follow --print-main)".Trim()
if ($base -notmatch '^[0-9a-f]{40}$') { Write-Host "  Could not read main's commit from GitHub (gh api): '$base'" -ForegroundColor Red; exit 1 }
$status = (Invoke-Ctl "status") -join " "
$boxBase = if ($status -match 'base=([0-9a-f]+)') { $Matches[1] } else { "none" }
$active  = $status -match 'scope=active'
$devFlag = if ($DevAuth) { "1" } else { "0" }
$devNow  = if ($status -match 'devauth=(\d)') { $Matches[1] } else { "0" }
$modeNow = if ($status -match 'mode=(\w+)') { $Matches[1] } else { "dev" }

if ($Resync -or -not $base.StartsWith($boxBase)) {
  Write-Step "moving the box to main $($base.Substring(0,9)) and installing (1-3 min the first time)..."
  $out = Invoke-Ctl "prepare $base"
  $out | Select-Object -Last 4 | ForEach-Object { Write-Step $_ }
  if (-not ($out -match '^PREPARED ')) {
    if ($out -match 'NO_ENV') { Write-Host "  No env on the box yet. Run:  phx-live -InstallEnv" -ForegroundColor Red }
    exit 1
  }
  $active = $false
}
if (-not $active -or $devNow -ne $devFlag -or $modeNow -ne $Mode) {
  Invoke-Ctl "serve $devFlag $Mode" | ForEach-Object { Write-Step $_ }
} else {
  Write-Step "the box server is already running at this base in this mode - reusing it"
}

# ---- 3. the follow window, then the tunnel ---------------------------------------------------
Start-Process -FilePath "node" -WindowStyle Minimized -ArgumentList @(
  "`"$Follow`"", "--base", $base, "--devauth", $devFlag, "--mode", $Mode)
$tunnelArgs = @("-i", "`"$Key`"", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15",
                "-N", "-L", "${LocalPort}:127.0.0.1:3100", "phxtunnel@$BoxHost")
Start-Process -FilePath "ssh" -ArgumentList $tunnelArgs -WindowStyle Minimized
Start-Sleep -Seconds 3

# ---- 4. wait for the first answer through the tunnel -----------------------------------------
# Production build: the first build takes about 3-4 minutes (a reused box answers at once with its
# previous build while the new one runs). next dev: the first compile.
$limitMin = if ($Mode -eq "fast") { 12 } else { 6 }
Write-Step $(if ($Mode -eq "fast") { "building the app on the box (about 3-4 min; up to $limitMin)..." } else { "waiting for the first compile (up to 6 min)..." })
$ok = $false
$t0 = Get-Date
$lastNote = $t0
$boxBuild = ""
while (((Get-Date) - $t0).TotalMinutes -lt $limitMin) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$LocalPort/api/healthz" -UseBasicParsing -TimeoutSec 15
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { Start-Sleep -Seconds 5 }
  if ($Mode -eq "fast" -and ((Get-Date) - $lastNote).TotalSeconds -ge 30) {
    $lastNote = Get-Date
    $s = (Invoke-Ctl "status") -join " "
    if ($s -match 'build=(\S+)') { $boxBuild = $Matches[1] }
    Write-Step "  box: $boxBuild ($([int]((Get-Date) - $t0).TotalSeconds) s)"
    if ($boxBuild -eq "failed") { break }
  }
}
if (-not $ok) {
  $why = if ($boxBuild -eq "failed") { "The build FAILED." } else { "It never answered through the tunnel." }
  Write-Host "  $why Last lines of the box log:" -ForegroundColor Red
  & ssh @SshOpts "phx@$BoxHost" "tail -30 /home/phx/live.log 2>/dev/null" | ForEach-Object { Write-Step $_ }
  exit 1
}
if ($Mode -eq "fast") {
  $s = (Invoke-Ctl "status") -join " "
  if ($s -match 'build=(\S+)') { $boxBuild = $Matches[1] }
}
Write-Host ""
Write-Host "  READY in $([int]((Get-Date) - $t0).TotalSeconds) s  ->  http://localhost:$LocalPort   (PRODUCTION DATA)" -ForegroundColor Green
if ($Mode -eq "fast") {
  if ($boxBuild -ne "serving") {
    Write-Host "  It is serving the PREVIOUS build while main $($base.Substring(0,9)) builds - reload in about 3-4 min." -ForegroundColor Yellow
  }
  Write-Host "  Every merge to main is picked up within a minute and rebuilt (about 3-4 min); the minimised follow window prints SERVING when it is in - then reload." -ForegroundColor DarkGray
  Write-Host "  /admin/dev-preview or a dev-auth role sweep:  phx-live -Dev  /  phx-live -DevAuth" -ForegroundColor DarkGray
} else {
  Write-Host "  Every merge to main is picked up within a minute; next dev recompiles a page as you open it. The follow is the minimised node window." -ForegroundColor DarkGray
}
Write-Host "  Notifying actions (approve, publish, nudge) belong on the real site - from here they are lost." -ForegroundColor DarkGray
Write-Host "  Stop everything with:  phx-live -Stop" -ForegroundColor DarkGray
if (-not $NoBrowser) { Start-Process "http://localhost:$LocalPort" }
