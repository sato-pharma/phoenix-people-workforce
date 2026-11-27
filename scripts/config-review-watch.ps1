# =============================================================================
# config-review-watch.ps1 - run the weekly Claude config review and tell the
# owner on Telegram when it finds NEW drift since the last alert.
#
# WHY THIS EXISTS. claude-config-review.mjs writes a report every run but tells
# nobody; quietly-added permissions, hooks, MCP servers, skills or auto-mode
# grants only surface if someone opens ~/.claude/reviews/latest.md. The owner
# asked (2026-10-05) to be pinged when the weekly review finds new drift.
#
# HOW. This runs the review with --alert, which diffs the current snapshot
# against the watcher's OWN persisted baseline (~/.claude/reviews/.alert-baseline.json,
# separate from snapshots/ so an ad-hoc run between weekly runs cannot shrink the
# weekly delta) and writes ~/.claude/reviews/.alert-payload.json. We read that and
# send a Telegram alert only when driftCount > 0. The baseline advances every run,
# so each weekly message is exactly the week's delta.
#
# TELEGRAM, NOT EMAIL. Matches xlsx-snapshot-watch.ps1 - the owner's chat is
# resolved live from the same place the app resolves it, so reconnecting Telegram
# never silently breaks this. Token and chat id stay inside this process; nothing
# is printed or copied.
#
# IT NEVER THROWS. A watcher that dies on an unexpected shape is a watcher that
# is not watching. Every failure path writes to its own log and exits 0.
#
# Modes:
#   (no args)   run the review with --alert and send a Telegram alert on drift
#   -Check      resolve the owner's chat + token and report whether a send COULD
#               happen - no review, no message sent (plumbing proof)
#   -Test       send one harmless confirmation message by hand (proves the channel)
# =============================================================================

[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Test
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$REPO    = 'F:\Phoenix Workforce\phoenix-workforce'
$SCRIPT  = Join-Path $env:USERPROFILE '.claude\scripts\claude-config-review.mjs'
$OUT     = Join-Path $env:USERPROFILE '.claude\reviews'
$PAYLOAD = Join-Path $OUT '.alert-payload.json'
$LOG     = Join-Path $env:USERPROFILE '.claude\scripts\config-review-watch.log'
$NODE    = if (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { 'node' }
$MAX_DRIFT_LINES = 25   # cap the message so a big diff does not blow up one Telegram message

function Write-WatchLog {
  param([string]$m)
  try { Add-Content -LiteralPath $LOG -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $m) -Encoding utf8 } catch { }
}

# ---------------------------------------------------------------------------
# .env.local is the machine's own credential store. Read, never printed, never
# copied anywhere: the values stay inside this process. (Same as xlsx-snapshot-watch.ps1.)
# ---------------------------------------------------------------------------
function Read-EnvValue {
  param([string]$Key)
  $path = Join-Path $REPO '.env.local'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  foreach ($line in (Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)) {
    if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
      $v = $Matches[1].Trim()
      if ($v.StartsWith('"') -and $v.EndsWith('"') -and $v.Length -ge 2) { $v = $v.Substring(1, $v.Length - 2) }
      if ($v.StartsWith("'") -and $v.EndsWith("'") -and $v.Length -ge 2) { $v = $v.Substring(1, $v.Length - 2) }
      return $v
    }
  }
  return $null
}

# Resolve the owner's chat the same way admin-telegram-mirror.ts does: the
# standing admin email -> hr_id -> a CONNECTED telegram_connections row.
function Get-OwnerChatIds {
  $url = Read-EnvValue 'NEXT_PUBLIC_SUPABASE_URL'
  $key = Read-EnvValue 'SUPABASE_SERVICE_ROLE_KEY'
  if (-not $url -or -not $key) { Write-WatchLog 'FAILED - no Supabase credentials in .env.local'; return @() }
  # Supabase refuses the sb_secret key from anything that looks like a browser, and
  # Windows PowerShell 5.1 sends "Mozilla/5.0 ..." by default: every chat lookup
  # answered 401 from about 8 Oct to 27 Oct 2026 and no alarm reached Telegram.
  $SUPABASE_UA = 'phoenix-watch/1.0'
  $headers = @{ apikey = $key; Authorization = 'Bearer ' + $key }
  try {
    $emp = Invoke-RestMethod -Method Get -Headers $headers -TimeoutSec 30 -UserAgent $SUPABASE_UA `
      -Uri ($url.TrimEnd('/') + '/rest/v1/employees?select=hr_id&work_email=ilike.omar.anwar@satopharma.com&limit=1')
    if (-not $emp -or $emp.Count -eq 0) { Write-WatchLog 'FAILED - the standing admin email matched no employee'; return @() }
    $hrId = $emp[0].hr_id
    $conn = Invoke-RestMethod -Method Get -Headers $headers -TimeoutSec 30 -UserAgent $SUPABASE_UA `
      -Uri ($url.TrimEnd('/') + '/rest/v1/telegram_connections?select=telegram_chat_id&status=eq.connected&hr_id=ilike.' + [uri]::EscapeDataString($hrId))
    $ids = @()
    foreach ($row in $conn) { if ($row.telegram_chat_id) { $ids += [string]$row.telegram_chat_id } }
    if ($ids.Count -eq 0) { Write-WatchLog 'FAILED - the owner has no CONNECTED telegram_connections row' }
    return $ids
  } catch {
    Write-WatchLog ('FAILED - could not resolve the chat: ' + $_.Exception.Message)
    return @()
  }
}

function Send-OwnerTelegram {
  param([string]$Text)
  $token = Read-EnvValue 'TELEGRAM_BOT_TOKEN'
  if (-not $token) { Write-WatchLog 'FAILED - TELEGRAM_BOT_TOKEN missing'; return $false }
  $chatIds = Get-OwnerChatIds
  if ($chatIds.Count -eq 0) { return $false }
  $sent = $false
  foreach ($chatId in $chatIds) {
    try {
      Invoke-RestMethod -Method Post -TimeoutSec 30 `
        -Uri ('https://api.telegram.org/bot' + $token + '/sendMessage') `
        -Body @{ chat_id = $chatId; text = $Text; disable_web_page_preview = 'true' } | Out-Null
      $sent = $true
    } catch {
      Write-WatchLog ('FAILED - Telegram send: ' + $_.Exception.Message)
    }
  }
  return $sent
}

# ---------------------------------------------------------------------------
try {
  # -Check: prove the plumbing without sending or running the review.
  if ($Check) {
    $token = Read-EnvValue 'TELEGRAM_BOT_TOKEN'
    $ids = Get-OwnerChatIds
    $okToken = [bool]$token
    $okChat  = $ids.Count -gt 0
    $msg = "CHECK - token present: $okToken ; chats resolved: $($ids.Count) ; would send: $($okToken -and $okChat)"
    Write-WatchLog $msg
    Write-Output $msg
    exit 0
  }

  # -Test: one harmless confirmation message by hand.
  if ($Test) {
    $ok = Send-OwnerTelegram ("Phoenix config-review alert - TEST ONLY, nothing is wrong." + [char]10 + [char]10 +
      "This is the Claude-config drift alert, sent by hand to prove the channel works. " +
      "From now on you only hear from it when the daily review finds a permission, hook, MCP server, skill or grant that changed since the previous run.")
    Write-WatchLog ('test send: ' + $ok)
    Write-Output ('test send: ' + $ok)
    exit 0
  }

  # Normal run: review with --alert, then alert on drift.
  & $NODE $SCRIPT --quiet --alert
  Write-WatchLog ('review exit: ' + $LASTEXITCODE)

  if (-not (Test-Path -LiteralPath $PAYLOAD)) { Write-WatchLog 'FAILED - no alert payload written'; exit 0 }
  $p = $null
  try { $p = Get-Content -LiteralPath $PAYLOAD -Raw | ConvertFrom-Json } catch { Write-WatchLog ('FAILED - payload unreadable: ' + $_.Exception.Message); exit 0 }

  if ($p.firstRun) { Write-WatchLog 'baseline established (first alert run) - no message'; exit 0 }
  if ([int]$p.driftCount -le 0) {
    $hm = ([int]$p.high.Count) + ([int]$p.medium.Count)
    Write-WatchLog ("no drift since last alert (" + $p.baselineAt + ") - no message ; open high+medium=" + $hm)
    exit 0
  }

  $lines = @($p.drift)
  $shown = $lines | Select-Object -First $MAX_DRIFT_LINES
  $more  = if ($lines.Count -gt $MAX_DRIFT_LINES) { "`n...and " + ($lines.Count - $MAX_DRIFT_LINES) + " more change(s)" } else { "" }

  $sinceStr = 'the last run'
  if ($p.baselineAt) {
    try { $sinceStr = ([datetime]$p.baselineAt).ToLocalTime().ToString('ddd dd MMM HH:mm') } catch { $sinceStr = 'the last run' }
  }
  $head = "Phoenix config-review alert - " + [int]$p.driftCount + " change(s) to your Claude setup since " + $sinceStr + "."
  $body = ($shown -join "`n")
  $hi = if ($p.high.Count) { "`n`nHIGH: " + ($p.high -join " ; ") } else { "" }
  $me = if ($p.medium.Count) { "`nMEDIUM: " + ($p.medium -join " ; ") } else { "" }
  $foot = "`n`nFull report: " + $p.reportFile + [char]10 +
          "If a change was yours, tell Claude to accept it so it stops being flagged."

  $message = $head + [char]10 + [char]10 + $body + $more + $hi + $me + $foot
  $sent = Send-OwnerTelegram $message
  Write-WatchLog ('DRIFT: ' + [int]$p.driftCount + ' change(s) | telegram sent: ' + $sent)
  exit 0
}
catch {
  Write-WatchLog ('UNEXPECTED - ' + $_.Exception.Message)
  exit 0
}
