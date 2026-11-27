<#
  ONE status command for the spare laptop (owner, 2026-11-23: "Do 24, 31, 32" - #24).
    & ~/.claude/scripts/spare-status.ps1
  Read-only: one ssh login plus one read of production's /api/healthz. It changes nothing.
  Shows: live version against production, a pull request preview, the last test run, memory, the link's delay, the Wi-Fi,
  firewall and login blocking, the disk, and the last line of every nightly job.
#>
$ErrorActionPreference = 'Continue'
$ssh = "$env:SystemRoot\System32\OpenSSH\ssh.exe"
function Cairo([string]$iso) { try { [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId(([datetimeoffset]::Parse($iso)).UtcDateTime, 'Egypt Standard Time').ToString('HH:mm, dd MMM') } catch { $iso } }
$prod = $null; try { $prod = (Invoke-RestMethod 'https://phoenix-hr.satopharma.com/api/healthz' -TimeoutSec 20).revision } catch {}
$remote = @'
R=~/phoenix/phoenix-workforce
echo "COMMIT $(git -C $R rev-parse HEAD 2>/dev/null) $(git -C $R log -1 --format=%s 2>/dev/null)"
echo "LIVE $(systemctl is-active phoenix-dev) $(curl -fsS -m 10 http://127.0.0.1:3000/api/healthz 2>/dev/null | sed -n 's/.*"startedAt":"\([^"]*\)".*/\1/p')"
echo "PREVIEW $(systemctl is-active phoenix-preview)"
echo "MEM $(tail -1 ~/phoenix/dev-memory.log 2>/dev/null | cut -d' ' -f3-)"
echo "LINK $(tail -1 ~/phoenix/link-delay.log 2>/dev/null | cut -d' ' -f3-)"
echo "WIFI $(tail -1 /var/log/phoenix-wifi-rejoin.log 2>/dev/null || echo none)"
echo "FW $(sudo -n ufw status 2>/dev/null | head -1 | cut -d' ' -f2) $(systemctl is-active fail2ban) banned=$(sudo -n fail2ban-client status sshd 2>/dev/null | sed -n 's/.*Currently banned:[[:space:]]*//p')"
echo "DISK $(df -h / | awk 'NR==2 {print $4" free of "$2}') copy=$(du -sh ~/archive-copy 2>/dev/null | cut -f1)"
echo "PAGES $(tail -1 ~/phoenix/page-check.log 2>/dev/null)"
echo "WARM $(tail -1 ~/phoenix/warm.log 2>/dev/null)"
echo "CLEAN $(tail -1 ~/phoenix/clean-up.log 2>/dev/null || echo 'not run yet')"
echo "HEALTH $(tail -1 ~/phoenix/disk-health.log 2>/dev/null || echo 'not run yet')"
echo "TEST $(ls -t ~/phoenix/runs 2>/dev/null | head -1) lock=$(flock -n ~/phoenix/test.lock true 2>/dev/null && echo free || echo 'held - a test run is going')"
echo "UP $(uptime -p)"
'@
# The script goes in on stdin, never as an argument: Windows drops the double quotes inside an argument.
$lines = @(($remote -replace "`r", '') | & $ssh -o BatchMode=yes -o ConnectTimeout=15 phoenix-spare "tr -d '\r' | bash -s" 2>$null)
if (-not $lines) { Write-Output 'SPARE LAPTOP NOT ANSWERING (asleep, off or off the Wi-Fi). The tunnel log: ~/.claude/logs/spare-tunnel.log'; exit 1 }
$v = @{}; foreach ($l in $lines) { $k, $rest = "$l" -split ' ', 2; $v[$k] = "$rest".Trim() }
$commit = ($v['COMMIT'] -split ' ', 2)
$same = $prod -and $commit[0] -and $commit[0].StartsWith($prod.Substring(0, [Math]::Min(9, $prod.Length)))
$live = $v['LIVE'] -split ' ', 2
Write-Output ("Live version   : {0}" -f $(if ($same) { "SAME as production ($($commit[0].Substring(0,9)) $($commit[1]))" } elseif ($prod) { "DIFFERENT - spare $($commit[0].Substring(0,9)), production $($prod.Substring(0,9)) (the follow task moves it within 10 minutes)" } else { "spare $($commit[0].Substring(0,9)); production's version could not be read" }))
Write-Output ("Live server    : {0}{1}" -f $live[0], $(if ($live.Count -gt 1 -and $live[1]) { ", started $(Cairo $live[1]) Cairo" } else { ', not answering' }))
Write-Output ("Preview (3001) : {0}" -f $(if ($v['PREVIEW'] -eq 'active') { (& "$PSScriptRoot\spare-preview.ps1" status 2>$null | Select-Object -Last 1) } else { 'none' }))
Write-Output ("Memory         : {0}" -f $v['MEM'])
Write-Output ("Link delay     : {0}" -f $v['LINK'])
Write-Output ("Wi-Fi repairs  : {0}" -f $v['WIFI'])
$fw = $v['FW'] -split ' '; Write-Output ("Firewall/logins: firewall {0}, login blocking {1}, {2}" -f $fw[0], $fw[1], $fw[2])
Write-Output ("Disk           : {0}" -f $v['DISK'])
Write-Output ("Test runs      : {0}" -f $v['TEST'])
Write-Output ("Page check     : {0}" -f $v['PAGES'])
Write-Output ("Last warm-up   : {0}" -f $v['WARM'])
Write-Output ("Clean-up       : {0}" -f $v['CLEAN'])
Write-Output ("Disk health    : {0}" -f $v['HEALTH'])
$ac = Join-Path $env:USERPROFILE '.claude\logs\spare-archive-copy.log'
Write-Output ("Archive copy   : {0}" -f $(if (Test-Path $ac) { Get-Content $ac -Tail 1 } else { 'not run yet' }))
$tl = Join-Path $env:USERPROFILE '.claude\logs\spare-tunnel.log'
$up = try { (Invoke-WebRequest 'http://localhost:3000/api/healthz' -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } catch { $false }
Write-Output ("Tunnel         : {0}; last event: {1}" -f $(if ($up) { 'UP - localhost:3000 answers' } else { 'DOWN - localhost:3000 does not answer' }), $(if (Test-Path $tl) { Get-Content $tl -Tail 1 } else { 'no log' }))
Write-Output ("Spare up       : {0}" -f $v['UP'])
