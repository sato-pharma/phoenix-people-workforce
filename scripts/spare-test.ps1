<#
.SYNOPSIS
  Runs Phoenix tests on the spare laptop instead of the 16 GB main laptop (owner, 2026-11-07:
  "we can rely on its 8 GB ... dev server and tests").

  THE SPARE RUNS UBUNTU SINCE 20 NOV 2026 (owner: "put Ubuntu Server on the spare") - the same kind of system CI runs
  on. A custom command is now BASH, not PowerShell. The Windows version is kept as spare-test.ps1.bak-20261120-windows.

  The spare holds a one-commit copy of main (no full history), topped up with only the new commits on each run. This
  script sends ONE patch: the difference between that commit and THIS checkout's exact state, committed work,
  uncommitted edits and new files alike. With -Rev it tests one commit exactly instead.

  ONE RUN AT A TIME, EACH IN ITS OWN FRESH FOLDER (2026-11-07): several sessions use the spare, and two runs sharing one
  test folder switched each other's files mid-run (17 false reds). So a run waits for the spare's test lock (flock on
  ~/phoenix/test.lock), builds ~/phoenix/runs/<id> from scratch, checks the files match what was sent to the byte (or
  refuses), runs, and removes the folder. The dev server's own checkout is never touched. The suite never gets
  .env.local (like CI: no production credentials). Exit code is the command's; 4 = refused, 5 = gave up waiting.

.EXAMPLE
  & ~/.claude/scripts/spare-test.ps1                      # the whole suite as CI's 4 shards, one at a time (never pnpm here)
  & ~/.claude/scripts/spare-test.ps1 'node scripts/check-contracts.mjs'
  & ~/.claude/scripts/spare-test.ps1 -Rev origin/main     # one commit exactly, no local changes
  & ~/.claude/scripts/spare-test.ps1 -Path 'F:\Phoenix Workforce\phoenix-workforce\_wt-foo'
#>
param([Parameter(Position = 0)][string]$Command, [string]$Path = (Get-Location).Path, [string]$Rev, [int]$MinFreeMb = 2048)
# The default is CI's own split: the suite as 4 shards (tests/shard-deal.ts), one at a time, then refused unless the
# shards' ran counts add up to the seen count. CI never runs the suite as one process.
if (-not $Command) {
  $Command = @'
seen=0; ran=0; skipped=0; red=0
# The CV worker test is left out here, and only here (owner, 2026-11-07: "skip the CV worker test on the spare only").
# tests/spare-skip.ts refuses the switch on CI, never counts the skip as ran, and prints PHX_SHARD_SKIPPED.
export PHX_SPARE_SKIP_CV_WORKER_TEST=1
out=$(mktemp)
for k in 1 2 3 4; do
  export PHX_TEST_SHARD="$k/4"
  # A shard killed by a crash signal (exit above 128) is run ONCE more; only the attempt that finished is counted.
  for try in 1 2; do
    echo "=== spare laptop: shard $k/4$([ $try -gt 1 ] && echo ' (again: the last attempt crashed)')"
    node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs tests/run-tests.ts 2>&1 | tee "$out" | grep -v '^PHX_TEST_'
    shard_exit=${PIPESTATUS[0]}
    [ "$shard_exit" -gt 128 ] && [ $try = 1 ] && continue
    break
  done
  r=$(sed -n 's/.*PHX_SHARD_RESULT shard=[^ ]* seen=\([0-9]*\) ran=\([0-9]*\).*/\1 \2/p' "$out" | tail -n 1)
  if [ -n "$r" ]; then seen=${r% *}; ran=$((ran + ${r#* })); fi
  s=$(sed -n 's/.*PHX_SHARD_SKIPPED shard=[^ ]* skipped=\([0-9]*\).*/\1/p' "$out" | tail -n 1)
  [ -n "$s" ] && skipped=$((skipped + s))
  if [ "$shard_exit" != 0 ]; then red=$((red + 1)); echo "=== shard $k/4 exit $shard_exit"; fi
done
rm -f "$out"; unset PHX_TEST_SHARD PHX_SPARE_SKIP_CV_WORKER_TEST
echo "spare laptop: 4 shards ran $ran of $seen tests + $skipped skipped on purpose (the CV worker test), $red shard(s) red"
if [ $((ran + skipped)) -ne "$seen" ] || [ "$seen" = 0 ] || [ "$skipped" -gt 1 ]; then echo 'spare laptop: the shards did not cover the suite - NOT a full run'; red=$((red + 1)); fi
[ "$red" = 0 ]
'@
}
$ErrorActionPreference = 'Continue'   # PS 5.1 turns any git warning on stderr into a fatal error under 'Stop'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$spareUser = "$(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'spare-user.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim(); if (-not $spareUser) { $spareUser = 'phoenix' }
$spare = "$spareUser@" + "$(& "$PSScriptRoot\spare-address.ps1" | Select-Object -Last 1)".Trim()   # found, never written here (2026-11-14)
$scpExe = "$env:SystemRoot\System32\OpenSSH\scp.exe"   # Windows OpenSSH even when called from Git Bash
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', '-i', $key)
$id = '{0}-{1}' -f (Get-Date -Format 'MMdd-HHmmss'), $PID
function Spare([string]$cmd) { & "$PSScriptRoot\spare.ps1" -Command $cmd -ConnectTimeout 20 }

# The spare's base commit lives at refs/spare/base.
$spareMain = "$(Spare 'git -C ~/phoenix/phoenix-workforce rev-parse --verify -q refs/spare/base || git -C ~/phoenix/phoenix-workforce rev-parse HEAD' | Select-Object -Last 1)".Trim()
if ($spareMain -notmatch '^[0-9a-f]{40}$') { throw "could not read the spare laptop's copy of main ($spareMain)" }
git -C $Path cat-file -e "$spareMain^{commit}" 2>$null
if ($LASTEXITCODE) { git -C $Path fetch -q origin main 2>$null; git -C $Path cat-file -e "$spareMain^{commit}" 2>$null }
if ($LASTEXITCODE) { throw "this checkout does not have commit $spareMain - run git fetch origin" }

$tmp = Join-Path $env:TEMP "spare-test-$id"; New-Item -ItemType Directory -Force $tmp | Out-Null
$code = 1
try {
  Spare 'mkdir -p ~/phoenix/inbox ~/phoenix/runs' | Out-Null
  # Top the spare's base up to this checkout's origin/main with only the new commits, so the patch below stays small.
  # Never touches the dev server's checkout (refs/spare/base is not a branch).
  $originMain = (git -C $Path rev-parse origin/main 2>$null | Select-Object -First 1)
  if ($originMain -and $originMain -ne $spareMain) {
    git -C $Path merge-base --is-ancestor $spareMain $originMain 2>$null
    if ($LASTEXITCODE -eq 0) {
      git -C $Path bundle create "$tmp\base.bundle" "$spareMain..origin/main" 2>$null | Out-Null
      if (Test-Path "$tmp\base.bundle") {
        & $scpExe @sshOpts "$tmp\base.bundle" "${spare}:phoenix/inbox/base-$id.bundle"
        Spare "git -C ~/phoenix/phoenix-workforce fetch -q ~/phoenix/inbox/base-$id.bundle '+refs/remotes/origin/main:refs/spare/base' >/dev/null 2>&1; c=`$?; rm -f ~/phoenix/inbox/base-$id.bundle; exit `$c" | Out-Null
        if ($LASTEXITCODE -eq 0) { $spareMain = $originMain }
      }
    }
  }
  # The exact state to test, staged on a throwaway index. git writes the patch file itself: a PowerShell pipe would
  # re-encode the binary parts.
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
  & $scpExe @sshOpts "$tmp\run.patch" "${spare}:phoenix/inbox/run-$id.patch"
  if ($LASTEXITCODE) { throw 'copy to the spare laptop failed' }

  $remote = @"
set -u
echo "spare laptop: tests on node `$(node -v)"
repo=~/phoenix/phoenix-workforce; run=~/phoenix/runs/$id; patch=~/phoenix/inbox/run-$id.patch
remove_run() { rm -f "`$1/node_modules"; git -C "`$repo" worktree remove --force "`$1" >/dev/null 2>&1; rm -rf "`$1"; }
cleanup() { cd ~/phoenix; remove_run "`$run"; rm -f "`$patch"; }
trap cleanup EXIT
# One run at a time: an exclusive lock, released when this script ends however it ends.
exec 9>~/phoenix/test.lock
if ! flock -n 9; then echo 'spare laptop: another test run is going - waiting for it'; flock -w 3600 9 || { echo 'gave up after 60 minutes waiting for the spare'; exit 5; }; fi
# Wait for 2 GB available (-MinFreeMb; spare-test-one.ps1 asks 700 for one file) before starting (owner, 2026-11-20, group 1): the spare also runs the dev server. 20 minutes,
# then nothing is tested (exit 5), never a run that starts short of memory.
said=0; deadline=`$((SECONDS + 1200))
while [ "`$(awk '/MemAvailable/ {print int(`$2/1024)}' /proc/meminfo)" -lt $MinFreeMb ]; do
  [ `$said = 0 ] && { echo 'spare laptop: under $MinFreeMb MB available - waiting for memory before the tests start'; said=1; }
  [ `$SECONDS -gt `$deadline ] && { echo 'gave up after 20 minutes waiting for $MinFreeMb MB available on the spare - nothing was tested'; exit 5; }
  sleep 15
done
# Holding the lock, nobody else is running: clear any folder a dropped run left behind.
for d in ~/phoenix/runs/*/; do [ -d "`$d" ] && remove_run "`${d%/}"; done
git -C "`$repo" worktree prune
git -C "`$repo" update-ref refs/remotes/origin/main $spareMain   # the changed-files lint diffs against origin/main
start=$spareMain
if [ -n '$revSha' ] && [ "`$(git -C "`$repo" cat-file -t '$revSha' 2>/dev/null)" = commit ]; then start='$revSha'; fi
git -C "`$repo" worktree add -q --detach "`$run" "`$start" >/dev/null 2>&1
[ -d "`$run" ] || { echo 'could not make the test folder on the spare laptop'; exit 3; }
ln -s "`$repo/node_modules" "`$run/node_modules"
cd "`$run"
if [ "`$start" != '$revSha' ] && [ -s "`$patch" ]; then
  git apply --index --whitespace=nowarn "`$patch" 2>&1 || { echo 'the patch did not apply on the spare laptop'; exit 3; }
fi
# Refuse to test anything but the exact files that were meant: the index is the tree sent, and the working tree
# matches the index (node_modules is a link the index does not know, so it is not counted).
got=`$(git write-tree)
git update-index -q --refresh >/dev/null 2>&1
off=`$(git diff --name-only 2>/dev/null)
if [ "`$got" != '$wantTree' ] || [ -n "`$off" ]; then
  echo "REFUSED: the spare's files (tree `$got, `$(printf '%s' "`$off" | grep -c .) files off) are not the state sent (tree $wantTree) - nothing was tested"
  printf '%s\n' "`$off" | head -n 10 | sed 's/^/  off: /'
  exit 4
fi
echo "spare laptop: running the state of $head in a fresh folder ($patchKB KB on top of its copy of main)"
(
$Command
)
exit `$?
"@
  Spare $remote
  $code = $LASTEXITCODE
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
exit $code
