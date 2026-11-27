<#
.SYNOPSIS
  Send-SpareTelegram: one Telegram message to the owner, for the spare-laptop scripts (owner, 2026-11-22: "Do 3 and 6").
  Dot-sourced by spare-tunnel.ps1. The owner's chat is found the way admin-telegram-mirror.ts and xlsx-snapshot-watch.ps1
  find it: the standing admin email -> hr_id -> a CONNECTED telegram_connections row. Settings come from the primary
  checkout's .env.local. -DryRun resolves the chat and checks the bot token with getMe, and sends nothing.
  Returns 'sent', 'dry-run ok' or a reason it did not send.
#>
function Send-SpareTelegram {
  param([string]$Text, [switch]$DryRun)
  $envFile = 'F:\Phoenix Workforce\phoenix-workforce\.env.local'
  function EnvV([string]$k) {
    foreach ($line in (Get-Content -LiteralPath $envFile -ErrorAction SilentlyContinue)) {
      if ($line -match "^\s*$([regex]::Escape($k))\s*=\s*(.*)$") { return $Matches[1].Trim().Trim('"').Trim("'") }
    }
  }
  $token = EnvV 'TELEGRAM_BOT_TOKEN'; $url = EnvV 'NEXT_PUBLIC_SUPABASE_URL'; $key = EnvV 'SUPABASE_SERVICE_ROLE_KEY'
  if (-not $token -or -not $url -or -not $key) { return 'not sent: Telegram or Supabase settings missing in .env.local' }
  # Supabase refuses the secret key from a browser-like user agent, and PowerShell 5.1 sends "Mozilla/5.0" (see xlsx-snapshot-watch.ps1).
  $h = @{ apikey = $key; Authorization = 'Bearer ' + $key }; $ua = 'phoenix-watch/1.0'
  try {
    $emp = Invoke-RestMethod -Headers $h -UserAgent $ua -TimeoutSec 30 -Uri ($url.TrimEnd('/') + '/rest/v1/employees?select=hr_id&work_email=ilike.omar.anwar@satopharma.com&limit=1')
    if (-not $emp -or -not $emp[0].hr_id) { return 'not sent: the standing admin email matched no employee' }
    $conn = Invoke-RestMethod -Headers $h -UserAgent $ua -TimeoutSec 30 -Uri ($url.TrimEnd('/') + '/rest/v1/telegram_connections?select=telegram_chat_id&status=eq.connected&hr_id=ilike.' + [uri]::EscapeDataString($emp[0].hr_id))
    $chats = @($conn | ForEach-Object { $_.telegram_chat_id } | Where-Object { $_ })
  } catch { return "not sent: could not find the chat ($($_.Exception.Message))" }
  if ($chats.Count -eq 0) { return 'not sent: the owner has no connected Telegram chat' }
  if ($DryRun) {
    try { Invoke-RestMethod -TimeoutSec 20 -Uri "https://api.telegram.org/bot$token/getMe" | Out-Null; return "dry-run ok: $($chats.Count) chat(s), bot token valid" }
    catch { return 'dry-run: bot token REJECTED' }
  }
  $sent = $false
  foreach ($c in $chats) {
    try { Invoke-RestMethod -Method Post -TimeoutSec 30 -Uri "https://api.telegram.org/bot$token/sendMessage" -Body @{ chat_id = "$c"; text = $Text; disable_web_page_preview = 'true' } | Out-Null; $sent = $true } catch {}
  }
  if ($sent) { 'sent' } else { 'not sent: Telegram refused the message' }
}
