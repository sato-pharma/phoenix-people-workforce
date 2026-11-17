<#
.SYNOPSIS
  Phoenix Visual Intelligence — connects ChatGPT to the staging visual inspector through OpenAI's Secure MCP
  Tunnel. Nothing is deployed or exposed: the inspector listens on 127.0.0.1 only, and the tunnel client
  dials OUT to OpenAI.

.DESCRIPTION
  Starts two processes and stops both when either ends (or on Ctrl+C):
    1. node scripts/phoenix-inspect/mcp-http.mjs --runner local --port 8797, with the built-in sign-in
       (Google proves the owner) — it never sees the tunnel key.
    2. tunnel-client run --profile phoenix-visual-inspector, pointed at http://127.0.0.1:8797/mcp — the
       ONLY process that receives the tunnel runtime key, decrypted from the DPAPI file into its own
       environment and cleared from this shell straight after it starts.
  Port 8787 (the profile's original port) belongs to the Phoenix Attendance Agent — never stop it.

  Files it reads, all in %LOCALAPPDATA%\PhoenixInspect (never in Git — the repository is public):
    tunnel-runtime-key.dpapi   saved by Save-TunnelRuntimeKey.ps1 (DPAPI, this Windows user only)
    client_secret_*.json       the Google OAuth client (type: Desktop app), downloaded from Google Cloud
    owner-email.txt            the Gmail address allowed to sign in (asked once, then kept here)
    tunnel-client\v0.0.21\tunnel-client.exe

.PARAMETER RevokeAll
  The kill switch: every token ChatGPT holds stops at once (works while the inspector is running).

.EXAMPLE
  & "F:\Phoenix Workforce\phoenix-workforce\scripts\phoenix-inspect\connect-chatgpt.ps1"
.EXAMPLE
  & "F:\Phoenix Workforce\phoenix-workforce\scripts\phoenix-inspect\connect-chatgpt.ps1" -RevokeAll
#>
[CmdletBinding()]
param([switch]$RevokeAll, [int]$Port = 8797)

$ErrorActionPreference = 'Stop'
$folder = Join-Path $env:LOCALAPPDATA 'PhoenixInspect'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$server = Join-Path $repo 'scripts\phoenix-inspect\mcp-http.mjs'
$stateDir = Join-Path $folder 'oauth'

if ($RevokeAll) {
  $env:PHOENIX_INSPECT_MCP_STATE_DIR = $stateDir
  & node $server --revoke-all
  exit $LASTEXITCODE
}

if ($Port -eq 8787) { throw 'Port 8787 is the Phoenix Attendance Agent; choose another port.' }
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  # Running it a second time is the common case, not a fault: say the connector is already up and stop.
  $health = $null
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2 } catch { }
  $runningTunnel = @(Get-Process -Name 'tunnel-client' -ErrorAction SilentlyContinue)
  if ($health -and $health.service -eq 'phoenix-inspect-mcp') {
    if ($runningTunnel.Count -gt 0) {
      Write-Host "Already running: the Phoenix inspector (process $($busy[0].OwningProcess)) and its tunnel (process $($runningTunnel[0].Id)). ChatGPT can use the connector now; nothing was started."
      exit 0
    }
    throw "The Phoenix inspector is running on port $Port (process $($busy[0].OwningProcess)) but its tunnel is not, so ChatGPT cannot reach it. Stop process $($busy[0].OwningProcess), then run this again."
  }
  throw "Port $Port is already in use by another program (process $($busy[0].OwningProcess)); pass -Port <another>."
}

$tunnelExe = Join-Path $folder 'tunnel-client\v0.0.21\tunnel-client.exe'
$keyFile = Join-Path $folder 'tunnel-runtime-key.dpapi'
$profileFile = Join-Path $env:APPDATA 'tunnel-client\phoenix-visual-inspector.yaml'
foreach ($required in @($tunnelExe, $keyFile, $profileFile)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Missing: $required" }
}

$clients = @(Get-ChildItem -LiteralPath $folder -Filter 'client_secret_*.json' -File)
if ($clients.Count -eq 0) { throw "No Google OAuth client file: download it (Desktop app) into $folder" }
if ($clients.Count -gt 1) { throw "More than one client_secret_*.json in $folder; keep only the current one." }

$ownerFile = Join-Path $folder 'owner-email.txt'
if (-not (Test-Path -LiteralPath $ownerFile)) {
  $typed = (Read-Host 'The Gmail address allowed to sign in').Trim()
  if ($typed -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'That is not an email address; nothing saved.' }
  Set-Content -LiteralPath $ownerFile -Value $typed -Encoding ascii
}
$owner = (Get-Content -LiteralPath $ownerFile -Raw).Trim()

$tunnelId = (Select-String -LiteralPath $profileFile -Pattern 'tunnel_id:\s*"?(tunnel_[a-z0-9_]+)"?').Matches |
  Select-Object -First 1 | ForEach-Object { $_.Groups[1].Value }
if (-not $tunnelId) { throw "No tunnel_id in $profileFile" }

# 1. The inspector — started BEFORE the key is in this shell's environment, so it never inherits it.
$env:PHOENIX_INSPECT_GOOGLE_CLIENT_FILE = $clients[0].FullName
$env:PHOENIX_INSPECT_MCP_OWNER_SUBJECTS = $owner
$env:PHOENIX_INSPECT_MCP_STATE_DIR = $stateDir
$env:PHOENIX_INSPECT_MCP_TUNNEL_ID = $tunnelId
$inspector = Start-Process -FilePath 'node' -ArgumentList @("`"$server`"", '--runner', 'local', '--port', $Port) `
  -WorkingDirectory $repo -NoNewWindow -PassThru

$tunnel = $null
try {
  $ready = $false
  foreach ($attempt in 1..40) {
    if ($inspector.HasExited) { throw "The inspector stopped at start (exit $($inspector.ExitCode)); its reason is printed above." }
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2 | Out-Null; $ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ready) { throw 'The inspector did not answer /healthz within 20 seconds.' }

  # 2. The tunnel client — the only process given the key, then the key leaves this shell.
  # Set-Content wrote the encrypted key with a line ending; ConvertTo-SecureString refuses it untrimmed.
  $secure = (Get-Content -LiteralPath $keyFile -Raw).Trim() | ConvertTo-SecureString
  $env:CONTROL_PLANE_API_KEY = [System.Net.NetworkCredential]::new('', $secure).Password
  try {
    $tunnel = Start-Process -FilePath $tunnelExe -NoNewWindow -PassThru -ArgumentList @(
      'run', '--profile', 'phoenix-visual-inspector',
      '--mcp.server-url', "url=http://127.0.0.1:$Port/mcp,channel=main",
      # ChatGPT reaches the sign-in endpoints (discovery, registration, token, revocation) through the
      # tunnel's "harpoon" channel, which refuses a plain-http target unless told otherwise; without
      # this, ChatGPT reports "Couldn't discover OAuth settings". The only targets it registers are
      # the inspector's own discovered endpoints on 127.0.0.1, which never leave this laptop.
      '--harpoon.allow-plaintext-http'
    )
  } finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    $secure.Dispose()
  }

  Write-Host "Phoenix inspector on http://127.0.0.1:$Port/mcp (staging only), tunnel $tunnelId running. Ctrl+C stops both."
  while (-not $inspector.HasExited -and -not $tunnel.HasExited) { Start-Sleep -Seconds 1 }
} finally {
  foreach ($child in @($tunnel, $inspector)) {
    if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }
  }
  Write-Host 'Stopped the inspector and the tunnel client.'
}
