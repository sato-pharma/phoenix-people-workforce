<#
  Screenshots of a pull request's changed pages, BEFORE (live, localhost:3000) and AFTER (the pull request, localhost:3001),
  at desktop 1440 px and phone 375 px (owner, 2026-11-23: "Do 18, 19 and 20" - #18).
    & ~/.claude/scripts/spare-shots.ps1 649                          # the pages pull request 649 changes
    & ~/.claude/scripts/spare-shots.ps1 649 -Pages /admin,/organogram  # these pages instead
  🔴 ON THE OWNER'S WORD ONLY ("screenshots 649"), like a preview: it needs that pull request on localhost:3001, and starts
  the preview (spare-preview.ps1) when another one or none is running. The preview then runs to its own time limit.
  The browser runs ON THE SPARE (Playwright's headless Chromium, installed 23 Nov), one page at a time, waiting for 500 MB
  free first - this laptop does no work but copying the pictures back.
  WHICH PAGES: every page whose folder the pull request changes (app/**/page.tsx and the files beside it), at most 6; a
  page with a [placeholder] in its address is skipped. None found -> /admin and /employee-portals.
  WHO: /employee-portals pages as the National Sales Manager (AI-0008, as the page check), /hr pages as HR Resourcing
  (HR-011), every other page as Super Admin (B-10). The DATABASE IS PRODUCTION'S - the shots only open pages.
  OUT: F:\Phoenix Workforce\PR Screenshots\PR <n>\ - the PNGs, results.json and compare.html (before beside after).
  Every shot also measures a sideways scroll (the fits-the-screen golden rule) and compare.html flags it.
  -ListPages only prints the pages it would shoot and stops.
#>
param([Parameter(Mandatory, Position = 0)][int]$Pr, [string[]]$Pages, [switch]$ListPages)
$ErrorActionPreference = 'Continue'   # the spare prints its login banner on stderr; Stop would turn that into a failure
$ssh = "$env:SystemRoot\System32\OpenSSH\ssh.exe"; $scp = "$env:SystemRoot\System32\OpenSSH\scp.exe"
$gh = 'sato-pharma/phoenix-people-workforce'
$repo = 'F:\Phoenix Workforce\phoenix-workforce'
$dest = "F:\Phoenix Workforce\PR Screenshots\PR $Pr"
# 2>&1 and drop the login banner: with 2>$null, Windows PowerShell sometimes lost a one-line answer (23 Nov).
function Spare([string]$script) { ($script -replace "`r", '') | & $ssh -o BatchMode=yes -o ConnectTimeout=20 phoenix-spare "tr -d '\r' | bash -s" 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -notmatch '^phx-user=' } }

# 1 - the pages
if (-not $Pages) {
  $files = @(gh pr view $Pr --repo $gh --json files --jq '.files[].path')
  git -C $repo fetch -q origin main 2>$null
  $found = [System.Collections.Generic.List[string]]::new()
  foreach ($f in $files | Where-Object { $_ -like 'app/*' -and $_ -notlike 'app/api/*' }) {
    $dir = [IO.Path]::GetDirectoryName($f) -replace '\\', '/'
    while ($dir -and $dir -ne 'app') {
      $page = "$dir/page.tsx"
      $exists = ($files -contains $page) -or ((git -C $repo cat-file -t "origin/main:$page" 2>$null) -eq 'blob')
      if ($exists) { break }
      $dir = [IO.Path]::GetDirectoryName($dir) -replace '\\', '/'
    }
    if (-not $dir -or $dir -eq 'app') { if ($files -contains 'app/page.tsx' -and $f -eq 'app/page.tsx') { $found.Add('/') }; continue }
    $route = '/' + ((($dir -replace '^app/?', '') -split '/' | Where-Object { $_ -notmatch '^\(.*\)$' }) -join '/')
    if ($route -match '\[') { continue }
    if (-not $found.Contains($route)) { $found.Add($route) }
  }
  $Pages = @($found | Select-Object -First 6)
  if (-not $Pages) { $Pages = @('/admin', '/employee-portals'); Write-Output 'No page folder changed - shooting /admin and /employee-portals.' }
}
$shots = foreach ($p in $Pages) {
  if ($p -like '/employee-portals*') { @{ path = $p; role = 'National Sales Manager'; hr = 'AI-0008' } }
  elseif ($p -like '/hr/*') { @{ path = $p; role = 'HR Resourcing'; hr = 'HR-011' } }
  else { @{ path = $p; role = 'Super Admin'; hr = 'B-10' } }
}
Write-Output ("Pages: {0}" -f ($Pages -join ', '))
if ($ListPages) { exit 0 }   # only say which pages it would shoot

# 2 - that pull request on localhost:3001
# sudo: phxpreview's home is closed to phoenix. Without it the info read empty and a running preview was restarted (23 Nov).
$info = "$(Spare 'sudo -n cat /home/phxpreview/preview-info 2>/dev/null; systemctl is-active phoenix-preview')"
if ($info -notmatch "\b$Pr\b" -or $info -notmatch 'active$') {
  Write-Output "Starting the preview of pull request $Pr on localhost:3001 ..."
  & "$PSScriptRoot\spare-preview.ps1" $Pr | Write-Output
  if ($LASTEXITCODE -ne 0) { Write-Output 'NO SCREENSHOTS: the preview did not start.'; exit 1 }
}

# 3 - shoot on the spare
Get-Content -Raw "$PSScriptRoot\spare-shots.mjs" | ForEach-Object { $_ -replace "`r", '' } | & $ssh -o BatchMode=yes phoenix-spare 'cat > ~/phoenix/shots.mjs' 2>$null
$json = ConvertTo-Json @($shots) -Compress
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
$out = "/home/phoenix/phoenix/shots/pr-$Pr"
# Detached on the spare (setsid): a dropped ssh session once killed a shoot half-way (23 Nov, 2 of 8 shots). This side
# only waits for the DONE marker, asking every 15 s, for up to an hour.
Spare @"
rm -rf $out; mkdir -p $out; cd ~/phoenix/phoenix-workforce
setsid nohup bash -c 'SHOTS=`$(echo $b64 | base64 -d) OUT=$out timeout 3600 node ~/phoenix/shots.mjs > $out/run.log 2>&1; echo `$? > $out/DONE' </dev/null >/dev/null 2>&1 &
echo started
"@ | Write-Output
$t = [Diagnostics.Stopwatch]::StartNew(); $seen = -1
while ($t.Elapsed.TotalMinutes -lt 62) {
  Start-Sleep -Seconds 15
  $st = "$(Spare "test -f $out/DONE && echo DONE; ls $out/*.png 2>/dev/null | wc -l")"
  $n = if ("$st" -match '(\d+)\s*$') { [int]$Matches[1] } else { 0 }
  if ($n -ne $seen) { Write-Output ("  {0} of {1} shots taken ({2:mm\:ss})" -f $n, (@($shots).Count * 4), $t.Elapsed); $seen = $n }
  if ("$st" -match 'DONE') { break }
}
Spare "cat $out/run.log" | Write-Output

# 4 - copy back and build the comparison page
New-Item -ItemType Directory -Force -Path $dest | Out-Null
# no backslash before the closing quote: Windows reads \" as an escaped quote and the copy went nowhere (23 Nov)
& $scp -q -o BatchMode=yes "phoenix-spare:$out/*" "$dest" 2>$null
$res = Get-Content -Raw (Join-Path $dest 'results.json') -ErrorAction SilentlyContinue | ConvertFrom-Json
if (-not $res) { Write-Output "NO SCREENSHOTS came back (see the lines above)."; exit 1 }
$enc = { param($s) [System.Net.WebUtility]::HtmlEncode("$s") }
$rows = foreach ($g in $res | Group-Object page, view) {
  $b = $g.Group | Where-Object side -eq 'before'; $a = $g.Group | Where-Object side -eq 'after'
  $cell = { param($r) if (-not $r) { '<td>-</td>' } elseif ($r.error) { "<td class=bad>failed: $(& $enc $r.error)</td>" } else { "<td><div class=meta>$($r.status) &middot; landed on $(& $enc $r.landed)$(if ($r.sidewaysScroll -gt 0) { " &middot; <b class=bad>SIDEWAYS SCROLL $($r.sidewaysScroll) px</b>" })</div><img src=""$($r.file)"" alt=""""></td>" } }
  "<tr><th colspan=2>$(& $enc $g.Group[0].page) &middot; $($g.Group[0].view) &middot; as $(& $enc $g.Group[0].role)</th></tr><tr>$(& $cell $b)$(& $cell $a)</tr>"
}
@"
<!doctype html><meta charset=utf-8><title>PR $Pr screenshots</title>
<style>body{font:14px Segoe UI,Arial,sans-serif;color:#0b1f3a;margin:24px}h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:#44546a}
table{width:100%;table-layout:fixed;border-collapse:collapse}th{text-align:left;padding:14px 0 6px;border-bottom:1px solid #0b1f3a}
td{vertical-align:top;padding:8px 8px 8px 0;width:50%}img{width:100%;border:1px solid #c9d1dc}.meta{font-size:12px;color:#44546a;margin-bottom:4px}.bad{color:#b3261e}</style>
<h1>Pull request $Pr &middot; before and after</h1><p>Left: the live version (localhost:3000). Right: pull request $Pr (localhost:3001). Taken $(Get-Date -Format 'dd MMM yyyy HH:mm') Cairo.</p>
<table><colgroup><col><col></colgroup>$($rows -join "`n")</table>
"@ | Set-Content -LiteralPath (Join-Path $dest 'compare.html') -Encoding utf8
$bad = @($res | Where-Object { $_.error }).Count; $side = @($res | Where-Object { $_.sidewaysScroll -gt 0 }).Count
Write-Output ("{0} screenshots, {1} failed, {2} with a sideways scroll -> {3}\compare.html" -f @($res).Count, $bad, $side, $dest)
