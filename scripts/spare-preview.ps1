<#
.SYNOPSIS
  Shows an UNMERGED pull request on localhost:3001, BESIDE the live version on localhost:3000, so the owner can click
  through it before he merges and compare the two (owner, 2026-11-20: "Set up PR preview"; side by side since
  2026-11-23: "do spare recommendations 15, 16 and 17"). The tunnel forwards both ports.

    & ~/.claude/scripts/spare-preview.ps1 649            # preview pull request 649 for 2 hours
    & ~/.claude/scripts/spare-preview.ps1 649 -Hours 4   # for 4 hours
    & ~/.claude/scripts/spare-preview.ps1 status         # what localhost:3000 is showing now
    & ~/.claude/scripts/spare-preview.ps1 stop           # back to the live version now
    & ~/.claude/scripts/spare-preview.ps1 previous       # the version BEFORE the last merge, beside the live one
    & ~/.claude/scripts/spare-preview.ps1 previous -Back 3   # three merges back
    & ~/.claude/scripts/spare-preview.ps1 62d7ab187      # any earlier commit of main

  PREVIOUS / A COMMIT (owner, 2026-11-23: "do spare recommendations 22, 23 and 25" - #25): when a merge breaks a page,
  localhost:3001 shows the version before it (or any earlier commit of main) beside the live one on localhost:3000, to
  compare the two. Same machinery, no pull request: the files are that commit exactly, with no patch. "Previous" counts
  merges on main back from the commit the live server runs (main is squash-merged, so one commit = one merge). Ready
  in about a minute when the packages did not change between the two, a few minutes when they did. His word only.

  🔴 ONLY ON THE OWNER'S OWN WORD ("preview 649"). localhost:3000 stays the live version (the golden rule holds all the
  time); the pull request is only ever on localhost:3001.

  🔴 PREVIEW REPLACES LIVE since 2026-11-27 (owner: "Preview replaces live", after "I need a real heavy corrective
  action"): two dev servers (~6.5 GB) did not fit the 7.6 GB, so while a preview runs the live server on 3000 is STOPPED;
  the unit's ExecStopPost starts it again when the preview ends. The follow task and the 04:00 restart skip it meanwhile.
  To compare with the live version, open production itself. The paragraph below is the 2026-11-23 side-by-side design.

  HOW: two dev servers fit the spare's 7.6 GB with its 3.7 GB of compressed memory (zram) when the preview's heap is 3 GB
  and it keeps 4 pages. On the spare:
    - systemd unit phoenix-preview, port 3001, beside phoenix-dev on 3000; it ends by its time limit, `stop` or a crash.
    - it runs as the user phxpreview, which has NO sudo: unmerged code and its package install scripts cannot take the
      machine. Folder /home/phxpreview/app, log /home/phxpreview/preview.log.
    - its files are production's version (the live checkout's commit) plus this pull request's difference, sent as one
      patch; the live checkout is never touched. It keeps its own packages and reinstalls only when the lockfile changes.
    - the DATABASE IS PRODUCTION'S (the same .env.local as the live dev server): anything done in a preview is real.
  The follow task (spare-follow-production.ps1) and the 04:00 restart leave a running preview alone.
  Setup is automatic: the first run (or a changed run script) creates the user, the unit and the run script.
#>
param([Parameter(Position = 0)][string]$Pr = 'status', [double]$Hours = 2, [int]$Back = 1)
$ErrorActionPreference = 'Continue'
$repo = 'F:\Phoenix Workforce\phoenix-workforce'
$gh = 'sato-pharma/phoenix-people-workforce'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$spareUser = "$(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'spare-user.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim(); if (-not $spareUser) { $spareUser = 'phoenix' }
$spare = "$spareUser@" + "$(& "$PSScriptRoot\spare-address.ps1" | Select-Object -Last 1)".Trim()
$scpExe = "$env:SystemRoot\System32\OpenSSH\scp.exe"
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', '-i', $key)
$log = Join-Path $env:USERPROFILE '.claude\logs\spare-preview.log'
function Log($m) { $l = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Write-Output $l; Add-Content -LiteralPath $log -Value $l -Encoding utf8 }
function Spare([string]$cmd) { & "$PSScriptRoot\spare.ps1" -Command $cmd -ConnectTimeout 20 }
function Cairo([long]$epoch) { [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::FromUnixTimeSeconds($epoch), 'Egypt Standard Time').ToString('HH:mm') }

function Show-Status {
  $s = @(Spare 'if systemctl is-active -q phoenix-preview; then echo "STATE preview"; echo "LIVE $(systemctl is-active phoenix-dev)"; sudo cat /home/phxpreview/preview-info; elif systemctl is-active -q phoenix-dev; then echo "STATE live"; else echo "STATE down"; fi')
  $state = "$($s | Where-Object { "$_" -like 'STATE *' } | Select-Object -First 1)"
  if ($state -eq 'STATE preview') {
    $info = "$($s | Where-Object { "$_" -like 'PR *' } | Select-Object -First 1)" -split ' '
    $title = "$($s | Where-Object { "$_" -like 'TITLE *' } | Select-Object -First 1)".Substring(6)
    $kind = if ($info[1] -eq 'commit') { 'AN EARLIER VERSION' } else { "PULL REQUEST $($info[1])" }
    $liveNow = if ("$s" -match 'LIVE active') { 'localhost:3000 is the live version (running beside it)' } else { 'localhost:3000 (live) is paused until it ends - preview replaces live since 2026-11-27' }
    Write-Output ("localhost:3001 is showing {0} ({1}), commit {2}, until {3} Cairo; {4}." -f $kind, $title, $info[2].Substring(0, 9), (Cairo ([long]$info[3])), $liveNow)
  } elseif ($state -eq 'STATE live') { Write-Output 'localhost:3000 is showing the LIVE version (production''s code). No preview is running on localhost:3001.' }
  else { Write-Output 'Neither the live dev server nor a preview is running on the spare (it may be starting).' }
}

if ($Pr -eq 'status') { Show-Status; exit 0 }
if ($Pr -eq 'stop') {
  $o = @(Spare 'if systemctl is-active -q phoenix-preview; then sudo systemctl stop phoenix-preview; echo STOPPED; else echo NONE; fi')
  if ("$o" -match 'STOPPED') { Log 'preview stopped; localhost:3001 is closed and the live version on localhost:3000 is starting again (ready in about 2 minutes)' } else { Write-Output 'No preview was running; localhost:3000 is the live version.' }
  exit 0
}
$mode = if ($Pr -match '^\d{1,6}$') { 'pr' } elseif ($Pr -eq 'previous' -or $Pr -match '^[0-9a-f]{7,40}$') { 'commit' } else { throw "Give a pull request number, 'previous', a commit, 'status' or 'stop' (got '$Pr')." }
if ($Back -lt 1 -or $Back -gt 50) { throw '-Back must be between 1 and 50.' }
$secs = [int][math]::Round($Hours * 3600); if ($secs -lt 600 -or $secs -gt 12 * 3600) { throw '-Hours must be between 0.17 and 12.' }

# 1. Setup on the spare, whenever the run script there differs from the one beside this file.
$runSrc = Join-Path $PSScriptRoot 'spare-preview-run.sh'
$runNow = "$(@(Spare 'echo "RUN $(sed "s/\r$//" /usr/local/lib/phoenix-preview/run.sh 2>/dev/null | sha256sum | cut -d" " -f1) $(test -f /etc/systemd/system/phoenix-preview.service && echo unit)"') | Where-Object { "$_" -like 'RUN*' } | Select-Object -First 1)".Trim()
$lfHash = (([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes(((Get-Content -LiteralPath $runSrc -Raw) -replace "`r`n", "`n")))) | ForEach-Object { $_.ToString('x2') }) -join ''
if ($runNow -ne "RUN $lfHash unit") {
  Spare 'mkdir -p ~/phoenix/inbox' | Out-Null
  & $scpExe @sshOpts $runSrc "${spare}:phoenix/inbox/preview-run.sh"
  $setup = @(& "$PSScriptRoot\spare.ps1" -File (Join-Path $PSScriptRoot 'spare-preview-setup.sh') -ConnectTimeout 20)
  if ("$setup" -notmatch 'SETUP OK') { Log "preview setup on the spare FAILED: $($setup -join ' | ')"; exit 1 }
  Log 'preview setup on the spare is current (user phxpreview, unit phoenix-preview, run script)'
}

# 2. The live checkout's commit on the spare.
$base = "$(Spare 'git -C ~/phoenix/phoenix-workforce rev-parse HEAD' | Select-Object -Last 1)".Trim()
if ($base -notmatch '^[0-9a-f]{40}$') { throw "the spare did not answer ($base)" }
git -C $repo cat-file -e "$base^{commit}" 2>$null
if ($LASTEXITCODE) { git -C $repo fetch -q origin main 2>$null; git -C $repo cat-file -e "$base^{commit}" 2>$null }
if ($LASTEXITCODE) { throw "this laptop does not have the spare's commit $base" }
$tmp = Join-Path $env:TEMP "spare-preview-$PID"; New-Item -ItemType Directory -Force $tmp | Out-Null
$patch = Join-Path $tmp 'preview.patch'
$behind = 0; $files = @()
if ($mode -eq 'commit') {
  # 3a. An earlier commit of main: that commit's files exactly, an empty patch.
  $want = if ($Pr -eq 'previous') { "$base~$Back" } else { $Pr }
  $sha = "$(git -C $repo rev-parse --verify -q "$want^{commit}" 2>$null | Select-Object -First 1)".Trim()
  if ($sha -notmatch '^[0-9a-f]{40}$') { Remove-Item -Recurse -Force $tmp; throw "no commit '$want' on this laptop" }
  if ($sha -eq $base) { Remove-Item -Recurse -Force $tmp; throw 'that commit IS the live version already on localhost:3000' }
  git -C $repo merge-base --is-ancestor $sha $base 2>$null
  if ($LASTEXITCODE) { Remove-Item -Recurse -Force $tmp; throw "commit $($sha.Substring(0, 9)) is not an earlier version of the live one ($($base.Substring(0, 9))) - only main's history is shown this way; an open pull request goes by its number" }
  $merges = [int](git -C $repo rev-list --count "$sha..$base" 2>$null)
  $title = "the version $merges merge(s) before the live one, $(git -C $repo log -1 --format=%s $sha 2>$null)"
  $files = @(git -C $repo diff --name-only $sha $base 2>$null | ForEach-Object { [pscustomobject]@{ path = $_ } })
  [IO.File]::WriteAllBytes($patch, [byte[]]@())
  $base = $sha; $label = 'commit'
} else {
  # 3b. The pull request: its difference from the live commit, as one patch.
  $p = gh pr view $Pr --repo $gh --json number,title,state,headRefOid,files | ConvertFrom-Json
  if (-not $p) { Remove-Item -Recurse -Force $tmp; throw "could not read pull request $Pr" }
  if ($p.state -ne 'OPEN') { Remove-Item -Recurse -Force $tmp; throw "pull request $Pr is $($p.state), not open - a merged one is already on localhost:3000 as the live version (the version before it: previous)" }
  $sha = $p.headRefOid; $title = "$($p.title)"; $files = @($p.files); $label = $Pr
  git -C $repo fetch -q origin "+refs/pull/$Pr/head:refs/spare-send/preview" 2>$null
  $got = (git -C $repo rev-parse refs/spare-send/preview 2>$null | Select-Object -First 1)
  git -C $repo update-ref -d refs/spare-send/preview 2>$null
  if ($got -ne $sha) { Remove-Item -Recurse -Force $tmp; throw "fetched $got for pull request $Pr, but GitHub says its head is $sha - try again in a minute" }
  $behind = [int](git -C $repo rev-list --count "$sha..$base" 2>$null)
  cmd /c "git -C `"$repo`" diff --binary --full-index $base $sha > `"$patch`""
  if ($LASTEXITCODE) { Remove-Item -Recurse -Force $tmp; throw 'could not make the patch' }
}
$what = if ($mode -eq 'commit') { "the earlier version $($sha.Substring(0, 9))" } else { "pull request $Pr" }
& $scpExe @sshOpts $patch "${spare}:phoenix/inbox/preview.patch"
$sent = $LASTEXITCODE
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
if ($sent) { throw 'could not send the patch to the spare' }

# 4. Build the preview folder and start it.
$ends = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + $secs
$titleB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($title))
$remote = @'
set -u
cd /   # phxpreview cannot enter phoenix's home; every path below is absolute
BASE=__BASE__; SHA=__SHA__; PR=__PR__; SECS=__SECS__; ENDS=__ENDS__
REPO=$HOME/phoenix/phoenix-workforce
back_to_live() { sudo rm -f /run/phoenix-preview-switching; systemctl is-active -q phoenix-preview || systemctl is-active -q phoenix-dev || sudo systemctl start phoenix-dev; }
git -C "$REPO" cat-file -e "$BASE^{commit}" || { echo 'PREVIEW-FAIL the spare no longer has its base commit'; exit 1; }
if systemctl is-active -q phoenix-preview; then sudo touch /run/phoenix-preview-switching; sudo systemctl stop phoenix-preview; fi
sudo -u phxpreview find /home/phxpreview/app -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
git -C "$REPO" archive "$BASE" | sudo -u phxpreview tar -x -C /home/phxpreview/app || { echo 'PREVIEW-FAIL could not copy the files'; back_to_live; exit 1; }
sudo install -o phxpreview -g phxpreview -m 600 "$HOME/phoenix/inbox/preview.patch" /home/phxpreview/preview.patch; rm -f "$HOME/phoenix/inbox/preview.patch"
if sudo test -s /home/phxpreview/preview.patch; then
  out=$(sudo -u phxpreview sh -c 'cd /home/phxpreview/app && git apply --whitespace=nowarn /home/phxpreview/preview.patch' 2>&1) || { echo "PREVIEW-FAIL the pull request did not apply: $out"; back_to_live; exit 1; }
fi
sudo install -o phxpreview -g phxpreview -m 600 "$REPO/.env.local" /home/phxpreview/app/.env.local
printf 'PR %s %s %s\nTITLE %s\n' "$PR" "$SHA" "$ENDS" "$(echo __TITLE__ | base64 -d)" | sudo -u phxpreview tee /home/phxpreview/preview-info >/dev/null
sudo mkdir -p /run/systemd/system/phoenix-preview.service.d
printf '[Service]\nRuntimeMaxSec=%s\n' "$SECS" | sudo tee /run/systemd/system/phoenix-preview.service.d/time.conf >/dev/null
sudo systemctl daemon-reload
sudo rm -f /run/phoenix-preview-switching
sudo systemctl reset-failed phoenix-preview 2>/dev/null
# PREVIEW REPLACES LIVE (owner, 2026-11-27: "Preview replaces live"): two dev servers do not fit 7.6 GB, so the live one
# pauses while a preview runs. The unit's ExecStopPost starts phoenix-dev again when the preview ends, however it ends.
sudo systemctl stop phoenix-dev
sudo systemctl start phoenix-preview && echo PREVIEW-STARTED || back_to_live
'@
$remote = $remote.Replace('__BASE__', $base).Replace('__SHA__', $sha).Replace('__PR__', $label).Replace('__SECS__', "$secs").Replace('__ENDS__', "$ends").Replace('__TITLE__', $titleB64)
$out = @(Spare $remote)
if ("$out" -notmatch 'PREVIEW-STARTED') { Log "preview of $what did NOT start: $(($out | Where-Object { $_ }) -join ' | ')"; exit 1 }
Log ("preview of {0} ({1}) starting, commit {2}; localhost:3001 until {3} Cairo; localhost:3000 (live) is paused until it ends" -f $what, $title, $sha.Substring(0, 9), (Cairo $ends))
if ($behind -gt 0) { Write-Output "note: this pull request's branch is $behind commit(s) behind the live version, so the preview lacks those newer changes." }
$mig = @($files | Where-Object { $_.path -like 'supabase/migrations/*' })
if ($mig.Count -and $mode -eq 'pr') { Write-Output "note: it carries $($mig.Count) database migration(s); a page that needs one not yet applied to production will error in the preview." }
if ($mig.Count -and $mode -eq 'commit') { Write-Output "note: $($mig.Count) database migration(s) landed since that version, and the database is production's TODAY - so on a page those migrations touch, a difference may come from the database, not the code." }

# 5. Wait until it answers (the first preview installs its packages: a few minutes).
$deadline = (Get-Date).AddMinutes(20)
while ((Get-Date) -lt $deadline) {
  Start-Sleep 10
  $w = "$(@(Spare 'if ! systemctl is-active -q phoenix-preview; then echo "W dead"; elif curl -fsS -m 10 -o /dev/null http://127.0.0.1:3001/api/healthz; then echo "W up"; else echo "W wait"; fi') | Where-Object { "$_" -like 'W *' } | Select-Object -First 1)"
  if ($w -eq 'W up') { Log "preview of $what is READY on localhost:3001 until $(Cairo $ends) Cairo"; exit 0 }
  if ($w -eq 'W dead') { Log "preview of $what STOPPED before answering (localhost:3000 is still the live version). Last log lines: $((Spare 'sudo tail -n 5 /home/phxpreview/preview.log') -join ' | ')"; exit 1 }
}
Log "preview of $what did not answer in 20 minutes; read /home/phxpreview/preview.log on the spare"
exit 1
