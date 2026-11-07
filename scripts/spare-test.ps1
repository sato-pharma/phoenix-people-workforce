<#
.SYNOPSIS
  Runs Phoenix tests on the spare laptop instead of the 16 GB main laptop (owner, 2026-11-07:
  "we can rely on its 8 GB ... dev server and tests").

  The spare holds a one-commit copy of main (no history: the home Wi-Fi could not carry 640 MB),
  topped up with only the new commits on each run. This script sends ONE patch: the difference
  between that commit and THIS checkout's exact state, committed work, uncommitted edits and new
  files alike. With -Rev it tests one commit exactly instead.

  ONE RUN AT A TIME, EACH IN ITS OWN FRESH FOLDER (2026-11-07): several sessions use the spare, and
  two runs sharing one test folder switched each other's files mid-run (17 false reds). So a run
  waits for the spare's test lock, builds D:\Phoenix\runs\<id> from scratch, checks the files match
  what was sent to the byte (or refuses), runs, and removes the folder. The dev server's own
  checkout is never touched. The suite never gets .env.local (like CI: no production credentials),
  and the working tree is LF (like CI). Exit code is the command's; 4 = refused, nothing tested.

.EXAMPLE
  & ~/.claude/scripts/spare-test.ps1                      # the whole suite (what pnpm run test runs; never pnpm here, it purges the linked node_modules)
  & ~/.claude/scripts/spare-test.ps1 'node scripts/check-contracts.mjs'
  & ~/.claude/scripts/spare-test.ps1 -Rev origin/main     # one commit exactly, no local changes
  & ~/.claude/scripts/spare-test.ps1 -Path 'F:\Phoenix Workforce\phoenix-workforce\_wt-foo'
#>
param([Parameter(Position = 0)][string]$Command = 'node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs tests/run-tests.ts', [string]$Path = (Get-Location).Path, [string]$Rev)
$ErrorActionPreference = 'Continue'   # PS 5.1 turns any git warning on stderr into a fatal error under 'Stop'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$spare = 'TransferUser@192.168.1.60'
$sshExe = "$env:SystemRoot\System32\OpenSSH\ssh.exe"; $scpExe = "$env:SystemRoot\System32\OpenSSH\scp.exe"   # Windows OpenSSH even when called from Git Bash
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', '-i', $key)
$id = '{0}-{1}' -f (Get-Date -Format 'MMdd-HHmmss'), $PID

# The spare's base commit lives at refs/spare/base (falls back to main, the commit it was copied at).
$spareMain = (& "$PSScriptRoot\spare.ps1" -Command 'git -C D:\Phoenix\phoenix-workforce rev-parse --verify -q refs/spare/base; if ($LASTEXITCODE) { git -C D:\Phoenix\phoenix-workforce rev-parse main }' -ConnectTimeout 20 | Select-Object -Last 1).Trim()
if ($spareMain -notmatch '^[0-9a-f]{40}$') { throw "could not read the spare laptop's copy of main ($spareMain)" }
git -C $Path cat-file -e "$spareMain^{commit}" 2>$null
if ($LASTEXITCODE) { git -C $Path fetch -q origin main 2>$null; git -C $Path cat-file -e "$spareMain^{commit}" 2>$null }
if ($LASTEXITCODE) { throw "this checkout does not have commit $spareMain - run git fetch origin" }

$tmp = Join-Path $env:TEMP "spare-test-$id"; New-Item -ItemType Directory -Force $tmp | Out-Null
$code = 1
try {
  & $sshExe @sshOpts $spare 'New-Item -ItemType Directory -Force D:\Phoenix\inbox, D:\Phoenix\runs | Out-Null'
  # Top the spare's base up to this checkout's origin/main with only the new commits, so the patch
  # below stays small. Never touches the dev server's checkout (refs/spare/base is not a branch).
  $originMain = (git -C $Path rev-parse origin/main 2>$null | Select-Object -First 1)
  if ($originMain -and $originMain -ne $spareMain) {
    git -C $Path merge-base --is-ancestor $spareMain $originMain 2>$null
    if ($LASTEXITCODE -eq 0) {
      git -C $Path bundle create "$tmp\base.bundle" "$spareMain..origin/main" 2>$null | Out-Null
      if (Test-Path "$tmp\base.bundle") {
        & $scpExe @sshOpts "$tmp\base.bundle" "${spare}:D:/Phoenix/inbox/base-$id.bundle"
        & "$PSScriptRoot\spare.ps1" -Command "git -C D:\Phoenix\phoenix-workforce fetch -q D:\Phoenix\inbox\base-$id.bundle '+refs/remotes/origin/main:refs/spare/base' 2>&1 | Out-Null; `$c = `$LASTEXITCODE; Remove-Item D:\Phoenix\inbox\base-$id.bundle -ErrorAction SilentlyContinue; exit `$c" -ConnectTimeout 20
        if ($LASTEXITCODE -eq 0) { $spareMain = $originMain }
      }
    }
  }
  # The exact state to test, staged on a throwaway index. git writes the patch file itself: a
  # PowerShell pipe would re-encode the binary parts.
  $revSha = ''
  $env:GIT_INDEX_FILE = "$tmp\index"
  try {
    if ($Rev) {
      $revSha = (git -C $Path rev-parse "$Rev^{commit}" 2>$null | Select-Object -First 1)
      if (-not $revSha) { throw "no such commit here: $Rev" }
      git -C $Path read-tree $revSha
      $head = $revSha.Substring(0, 9)
    } else {
      git -C $Path read-tree HEAD; git -C $Path -c core.safecrlf=false add -A 2>$null | Out-Null
      $head = (git -C $Path rev-parse --short HEAD).Trim()
    }
    git -C $Path diff --cached --binary --output="$tmp\run.patch" $spareMain
    $wantTree = (git -C $Path write-tree).Trim()
  } finally { Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue }
  $patchKB = [int]((Get-Item "$tmp\run.patch").Length / 1KB)
  & $scpExe @sshOpts "$tmp\run.patch" "${spare}:D:/Phoenix/inbox/run-$id.patch"
  if ($LASTEXITCODE) { throw 'copy to the spare laptop failed' }

  $remote = @"
`$ErrorActionPreference = 'Continue'
`$env:PATH = 'C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + `$env:APPDATA + '\npm'   # Git's bash first: the WSL bash.exe in WindowsApps fails the ci.yml step tests
`$repo = 'D:\Phoenix\phoenix-workforce'; `$run = 'D:\Phoenix\runs\$id'; `$patch = 'D:\Phoenix\inbox\run-$id.patch'
function Remove-Run([string]`$dir) {
  if (Test-Path "`$dir\node_modules") { cmd /c rmdir "`$dir\node_modules" | Out-Null }   # the junction first, never what it points at
  git -C `$repo worktree remove --force `$dir 2>&1 | Out-Null
  if (Test-Path `$dir) { Remove-Item -Recurse -Force `$dir -ErrorAction SilentlyContinue }
}
# One run at a time: an exclusive handle on the lock file, released when this session ends however it ends.
`$lock = `$null; `$waited = `$false; `$deadline = (Get-Date).AddMinutes(60)
while (-not `$lock) {
  try { `$lock = [IO.File]::Open('D:\Phoenix\test.lock', 'OpenOrCreate', 'ReadWrite', 'None') }
  catch { if (-not `$waited) { 'spare laptop: another test run is going - waiting for it'; `$waited = `$true }; if ((Get-Date) -gt `$deadline) { 'gave up after 60 minutes waiting for the spare'; exit 5 }; Start-Sleep 10 }
}
try {
  # Holding the lock, nobody else is running: clear any folder a dropped run left behind.
  Get-ChildItem D:\Phoenix\runs -Directory -ErrorAction SilentlyContinue | ForEach-Object { Remove-Run `$_.FullName }
  if (Test-Path D:\Phoenix\test-run) { Remove-Run 'D:\Phoenix\test-run' }
  git -C `$repo worktree prune
  git -C `$repo config core.autocrlf false   # like CI: LF in the working tree
  git -C `$repo update-ref refs/remotes/origin/main $spareMain   # the changed-files lint diffs against origin/main
  `$start = if ('$revSha' -and ((git -C `$repo cat-file -t '$revSha' 2>`$null) -eq 'commit')) { '$revSha' } else { '$spareMain' }
  git -C `$repo -c core.fsmonitor=false worktree add -q --detach `$run `$start 2>&1 | Out-Null
  if (-not (Test-Path `$run)) { 'could not make the test folder on the spare laptop'; exit 3 }
  cmd /c mklink /J "`$run\node_modules" "`$repo\node_modules" | Out-Null
  Set-Location `$run
  if (`$start -ne '$revSha' -and (Get-Item `$patch).Length -gt 0) {
    git -c core.fsmonitor=false apply --index --whitespace=nowarn `$patch 2>&1 | ForEach-Object { "`$_" }
    if (`$LASTEXITCODE) { 'the patch did not apply on the spare laptop'; exit 3 }
  }
  # Refuse to test anything but the exact files that were meant: the index is the tree sent, and the
  # working tree matches the index. Never 'git status' here: it also lists every file the patch STAGED
  # against the base commit, so every run carrying a patch read as "N files off" (2026-11-07, 142 = the patch).
  `$got = (git write-tree).Trim()
  git -c core.fsmonitor=false update-index -q --refresh 2>&1 | Out-Null
  `$off = @(git -c core.fsmonitor=false diff --name-only 2>`$null)
  if (`$got -ne '$wantTree' -or `$off.Count) {
    "REFUSED: the spare's files (tree `$got, `$(`$off.Count) files off) are not the state sent (tree $wantTree) - nothing was tested"
    `$off | Select-Object -First 10 | ForEach-Object { "  off: `$_" }
    exit 4
  }
  "spare laptop: running the state of $head in a fresh folder ($patchKB KB on top of its copy of main)"
  $Command
  `$code = `$LASTEXITCODE
} finally {
  Set-Location D:\Phoenix
  Remove-Run `$run
  Remove-Item `$patch -ErrorAction SilentlyContinue
  if (`$lock) { `$lock.Close() }
}
exit `$code
"@
  & "$PSScriptRoot\spare.ps1" -Command $remote -ConnectTimeout 20
  $code = $LASTEXITCODE
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
exit $code
