<#
.SYNOPSIS
  Runs Phoenix tests on the spare laptop instead of the 16 GB main laptop (owner, 2026-11-07:
  "we can rely on its 8 GB ... dev server and tests").

  The spare holds a one-commit copy of main (no history: the home Wi-Fi could not carry 640 MB).
  This script sends ONE patch: the difference between that commit and THIS checkout's exact state,
  committed work and uncommitted edits and new files alike. It applies the patch in a separate test
  folder on the spare (D:\Phoenix\test-run, sharing the dev server's node_modules), so the spare's
  dev server checkout is never touched. Then it runs the command there and streams the output back.
  The exit code is the command's.

.EXAMPLE
  & ~/.claude/scripts/spare-test.ps1                      # the whole suite (what pnpm run test runs; never pnpm here, it purges the linked node_modules)
  & ~/.claude/scripts/spare-test.ps1 'node scripts/check-contracts.mjs'
  & ~/.claude/scripts/spare-test.ps1 -Path 'F:\Phoenix Workforce\phoenix-workforce\_wt-foo'
#>
# -Rev <commit>: test that commit exactly (no local changes sent), e.g. -Rev origin/main.
param([Parameter(Position = 0)][string]$Command = 'node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs tests/run-tests.ts', [string]$Path = (Get-Location).Path, [string]$Rev)
$ErrorActionPreference = 'Continue'   # PS 5.1 turns any git warning on stderr into a fatal error under 'Stop'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$spare = 'TransferUser@192.168.1.60'
$sshExe = "$env:SystemRoot\System32\OpenSSH\ssh.exe"; $scpExe = "$env:SystemRoot\System32\OpenSSH\scp.exe"   # Windows OpenSSH even when called from Git Bash
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', '-i', $key)

# The spare's base commit lives at refs/spare/base (falls back to main, the commit it was copied at).
$spareMain = (& "$PSScriptRoot\spare.ps1" -Command 'git -C D:\Phoenix\phoenix-workforce rev-parse --verify -q refs/spare/base; if ($LASTEXITCODE) { git -C D:\Phoenix\phoenix-workforce rev-parse main }' -ConnectTimeout 20 | Select-Object -Last 1).Trim()
if ($spareMain -notmatch '^[0-9a-f]{40}$') { throw "could not read the spare laptop's copy of main ($spareMain)" }
git -C $Path cat-file -e "$spareMain^{commit}" 2>$null
if ($LASTEXITCODE) { git -C $Path fetch -q origin main 2>$null; git -C $Path cat-file -e "$spareMain^{commit}" 2>$null }
if ($LASTEXITCODE) { throw "this checkout does not have commit $spareMain - run git fetch origin" }

$tmp = Join-Path $env:TEMP "spare-test-$PID"; New-Item -ItemType Directory -Force $tmp | Out-Null
$code = 1
try {
  # Top the spare's base up to this checkout's origin/main with only the new commits, so the patch
  # below stays small. Never touches the dev server's checkout (refs/spare/base is not a branch).
  $originMain = (git -C $Path rev-parse origin/main 2>$null | Select-Object -First 1)
  if ($originMain -and $originMain -ne $spareMain) {
    git -C $Path merge-base --is-ancestor $spareMain $originMain 2>$null
    if ($LASTEXITCODE -eq 0) {
      git -C $Path bundle create "$tmp\base.bundle" "$spareMain..origin/main" 2>$null | Out-Null
      if (Test-Path "$tmp\base.bundle") {
        & $scpExe @sshOpts "$tmp\base.bundle" "${spare}:D:/Phoenix/inbox/base.bundle"
        & "$PSScriptRoot\spare.ps1" -Command "git -C D:\Phoenix\phoenix-workforce fetch -q D:\Phoenix\inbox\base.bundle '+refs/remotes/origin/main:refs/spare/base' 2>&1 | Out-Null; exit `$LASTEXITCODE" -ConnectTimeout 20
        if ($LASTEXITCODE -eq 0) { $spareMain = $originMain }
      }
    }
  }
  # This checkout's exact state, untracked files included, staged on a throwaway index.
  # git writes the patch file itself: a PowerShell pipe would re-encode the binary parts.
  if ($Rev) {
    $revSha = (git -C $Path rev-parse "$Rev^{commit}" 2>$null | Select-Object -First 1)
    if (-not $revSha) { throw "no such commit here: $Rev" }
    $env:GIT_INDEX_FILE = "$tmp\index"
    try { git -C $Path read-tree $revSha; git -C $Path diff --cached --binary --output="$tmp\run.patch" $spareMain; $wantTree = (git -C $Path write-tree).Trim() }
    finally { Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue }
    $head = $revSha.Substring(0, 9)
  } else {
    $env:GIT_INDEX_FILE = "$tmp\index"
    try {
      git -C $Path read-tree HEAD; git -C $Path -c core.safecrlf=false add -A 2>$null | Out-Null
      git -C $Path diff --cached --binary --output="$tmp\run.patch" $spareMain
      $wantTree = (git -C $Path write-tree).Trim()
    } finally { Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue }
    $head = (git -C $Path rev-parse --short HEAD).Trim()
  }
  $patchKB = [int]((Get-Item "$tmp\run.patch").Length / 1KB)

  & $sshExe @sshOpts $spare 'powershell -NoProfile -Command "New-Item -ItemType Directory -Force D:\Phoenix\inbox | Out-Null"'
  & $scpExe @sshOpts "$tmp\run.patch" "${spare}:D:/Phoenix/inbox/run.patch"
  if ($LASTEXITCODE) { throw 'copy to the spare laptop failed' }

  $remote = @"
`$ErrorActionPreference = 'Continue'
`$env:PATH = 'C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + `$env:APPDATA + '\npm'   # Git's bash first: the WSL bash.exe in WindowsApps fails the ci.yml step tests
`$repo = 'D:\Phoenix\phoenix-workforce'; `$run = 'D:\Phoenix\test-run'
if (-not (Test-Path `$run)) { git -C `$repo worktree add -q --detach `$run $spareMain 2>&1 | Out-Null }
if (-not (Test-Path "`$run\node_modules")) { cmd /c mklink /J "`$run\node_modules" "`$repo\node_modules" | Out-Null }
Remove-Item "`$run\.env.local" -Force -ErrorAction SilentlyContinue   # like CI: the suite never gets the production credentials
git -C `$repo config core.autocrlf false   # like CI: LF in the working tree, so CRLF-blind source pins do not false-red
Set-Location `$run
git -C `$repo update-ref refs/remotes/origin/main $spareMain   # the changed-files lint diffs against origin/main
git -c core.fsmonitor=false reset -q --hard 2>&1 | Out-Null
git -c core.fsmonitor=false checkout -q -f --detach $spareMain 2>&1 | Out-Null
git -c core.fsmonitor=false clean -qfd -e node_modules -e .env.local 2>&1 | Out-Null
git cat-file -e '$revSha^{commit}' 2>`$null
if ('$revSha' -and `$LASTEXITCODE -eq 0) {
  git -c core.fsmonitor=false checkout -q -f --detach $revSha 2>&1 | Out-Null   # the spare holds that commit: no patch needed
} elseif ((Get-Item D:\Phoenix\inbox\run.patch).Length -gt 0) {
  git -c core.fsmonitor=false apply --index --whitespace=nowarn D:\Phoenix\inbox\run.patch 2>&1 | ForEach-Object { "`$_" }
  if (`$LASTEXITCODE) { 'the patch did not apply on the spare laptop'; exit 3 }
}
# Refuse to test anything but the exact files that were meant: the snapshot must match to the byte.
`$got = (git write-tree).Trim()
if (`$got -ne '$wantTree') { "REFUSED: the spare's files (tree `$got) are not the state sent (tree $wantTree) - nothing was tested"; exit 4 }
"spare laptop: running the state of $head ($patchKB KB on top of its copy of main)"
$Command
exit `$LASTEXITCODE
"@
  & "$PSScriptRoot\spare.ps1" -Command $remote -ConnectTimeout 20
  $code = $LASTEXITCODE
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
exit $code
