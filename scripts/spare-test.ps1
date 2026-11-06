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
  & ~/.claude/scripts/spare-test.ps1                      # pnpm run test  (the whole suite)
  & ~/.claude/scripts/spare-test.ps1 'node scripts/check-contracts.mjs'
  & ~/.claude/scripts/spare-test.ps1 -Path 'F:\Phoenix Workforce\phoenix-workforce\_wt-foo'
#>
param([Parameter(Position = 0)][string]$Command = 'pnpm.cmd run test', [string]$Path = (Get-Location).Path)
$ErrorActionPreference = 'Continue'   # PS 5.1 turns any git warning on stderr into a fatal error under 'Stop'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$spare = 'TransferUser@192.168.1.60'
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', '-i', $key)

$spareMain = (& "$PSScriptRoot\spare.ps1" -Command 'git -C D:\Phoenix\phoenix-workforce rev-parse main' -ConnectTimeout 20 | Select-Object -Last 1).Trim()
if ($spareMain -notmatch '^[0-9a-f]{40}$') { throw "could not read the spare laptop's copy of main ($spareMain)" }
git -C $Path cat-file -e "$spareMain^{commit}" 2>$null
if ($LASTEXITCODE) { git -C $Path fetch -q origin main 2>$null; git -C $Path cat-file -e "$spareMain^{commit}" 2>$null }
if ($LASTEXITCODE) { throw "this checkout does not have commit $spareMain - run git fetch origin" }

$tmp = Join-Path $env:TEMP "spare-test-$PID"; New-Item -ItemType Directory -Force $tmp | Out-Null
$code = 1
try {
  # This checkout's exact state, untracked files included, staged on a throwaway index.
  # git writes the patch file itself: a PowerShell pipe would re-encode the binary parts.
  $env:GIT_INDEX_FILE = "$tmp\index"
  try {
    git -C $Path read-tree HEAD; git -C $Path -c core.safecrlf=false add -A 2>$null | Out-Null
    git -C $Path diff --cached --binary --output="$tmp\run.patch" $spareMain
  } finally { Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue }
  $patchKB = [int]((Get-Item "$tmp\run.patch").Length / 1KB)
  $head = (git -C $Path rev-parse --short HEAD).Trim()

  & ssh @sshOpts $spare 'powershell -NoProfile -Command "New-Item -ItemType Directory -Force D:\Phoenix\inbox | Out-Null"'
  & scp -O @sshOpts "$tmp\run.patch" "${spare}:D:/Phoenix/inbox/run.patch"
  if ($LASTEXITCODE) { throw 'copy to the spare laptop failed' }

  $remote = @"
`$ErrorActionPreference = 'Continue'
`$env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + `$env:APPDATA + '\npm'
`$repo = 'D:\Phoenix\phoenix-workforce'; `$run = 'D:\Phoenix\test-run'
if (-not (Test-Path `$run)) { git -C `$repo worktree add -q --detach `$run $spareMain 2>&1 | Out-Null }
if (-not (Test-Path "`$run\node_modules")) { cmd /c mklink /J "`$run\node_modules" "`$repo\node_modules" | Out-Null }
Copy-Item "`$repo\.env.local" "`$run\.env.local" -Force
Set-Location `$run
git -c core.fsmonitor=false checkout -q -f --detach $spareMain 2>&1 | Out-Null
git -c core.fsmonitor=false clean -qfd -e node_modules -e .env.local 2>&1 | Out-Null
if ((Get-Item D:\Phoenix\inbox\run.patch).Length -gt 0) {
  git apply --whitespace=nowarn D:\Phoenix\inbox\run.patch 2>&1 | ForEach-Object { "`$_" }
  if (`$LASTEXITCODE) { 'the patch did not apply on the spare laptop'; exit 3 }
}
"spare laptop: running the state of $head ($patchKB KB on top of its copy of main)"
$Command
exit `$LASTEXITCODE
"@
  & "$PSScriptRoot\spare.ps1" -Command $remote -ConnectTimeout 20
  $code = $LASTEXITCODE
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
exit $code
