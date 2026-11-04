$ErrorActionPreference = 'Stop'
# Rotate the LOCAL OpenAI key - the one a command of mine echoed into a session log on
# 2026-09-17 (sha256 469EBD3D, dashboard shows it ending ...sVQA).
#
# Railway production and staging run a DIFFERENT key (sha256 52023F78) and are NOT touched
# by this script, so nothing deploys and nothing in production changes.
#
# You type the new key here. It is never displayed, never written to a log, and never sent
# to Claude - only an 8-character fingerprint of it is printed.

$files = @(
  'F:\Phoenix Workforce\phoenix-workforce\.env.local',
  'F:\Phoenix Workforce\_wt-claude-automations\.env.local',
  'F:\Phoenix Workforce\_wt-sos-bricks-map-load\.env.local',
  'F:\Phoenix Workforce\phoenix-workforce\.claude\worktrees\blissful-jemison-92a6f5\.env.local',
  'F:\Phoenix Workforce\phoenix-workforce\.claude\worktrees\confident-chebyshev-b6c214\.env.local',
  'F:\Phoenix Workforce\phoenix-workforce\.claude\worktrees\gifted-franklin-801c25\.env.local'
)

Write-Host ''
Write-Host 'Create the new key first at https://platform.openai.com/api-keys, then paste it below.'
Write-Host 'Your typing stays hidden.'
Write-Host ''
$sec  = Read-Host -AsSecureString 'new OpenAI key'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$key  = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

if ([string]::IsNullOrWhiteSpace($key)) { throw 'nothing was pasted' }
if (-not $key.StartsWith('sk-'))        { throw 'that does not look like an OpenAI key - it must start with sk-' }
if ($key.Length -lt 40)                 { throw 'too short, the paste was truncated' }
if ($key -match '\s')                   { throw 'the paste contains a space or a line break' }
if ($key -match '\*|\.\.\.')            { throw 'that is the MASKED display value, not the key itself' }

$sha = [System.Security.Cryptography.SHA256]::Create()
$enc = [Text.Encoding]::UTF8
$fp  = [BitConverter]::ToString($sha.ComputeHash($enc.GetBytes($key))).Replace('-','').Substring(0,8)
if ($fp -eq '469EBD3D') { throw 'that is the OLD exposed key - create a NEW one, then run this again' }
if ($fp -eq '52023F78') { throw 'that is the PRODUCTION key - keep the two separate, create a new one for this laptop' }

Write-Host ''
Write-Host 'Testing the key against OpenAI before touching any file...'
try {
  $resp = Invoke-WebRequest -Uri 'https://api.openai.com/v1/models' -Headers @{ Authorization = ('Bearer ' + $key) } -UseBasicParsing -TimeoutSec 30
  Write-Host ('  OpenAI answered HTTP ' + [int]$resp.StatusCode + ' - the key works')
} catch {
  $code = 'no response'
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  throw ('OpenAI refused that key (HTTP ' + $code + ') - nothing was changed')
}

Write-Host ''
$done = 0
foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Host ('  missing, skipped : ' + $f); continue }
  $raw = [IO.File]::ReadAllText($f)
  $bak = $f + '.bak-openai-rotate-2026-09-17'
  if (-not (Test-Path $bak)) { [IO.File]::WriteAllText($bak, $raw) }
  $nl = "`n"
  if ($raw.Contains("`r`n")) { $nl = "`r`n" }
  $lines = $raw -split "`r?`n"
  $hit = 0
  for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match '^\s*OPENAI_API_KEY\s*=') { $lines[$i] = 'OPENAI_API_KEY=' + $key; $hit++ }
  }
  if ($hit -eq 0) { Write-Host ('  no OPENAI_API_KEY line : ' + $f); continue }
  [IO.File]::WriteAllText($f, ($lines -join $nl))

  $check = @([IO.File]::ReadAllText($f) -split "`r?`n" | Where-Object { $_ -match '^\s*OPENAI_API_KEY\s*=' })[0]
  $val   = $check -replace '^\s*OPENAI_API_KEY\s*=\s*', ''
  $vfp   = [BitConverter]::ToString($sha.ComputeHash($enc.GetBytes($val))).Replace('-','').Substring(0,8)
  $ok = 'MISMATCH'
  if ($vfp -eq $fp) { $ok = 'now ' + $vfp; $done++ }
  Write-Host ('  ' + $ok + '  ' + (Split-Path (Split-Path $f -Parent) -Leaf) + '\.env.local')
}

$key = $null
Write-Host ''
Write-Host ('Rewritten: ' + $done + ' of ' + $files.Count + ' files. Old copies kept as .bak-openai-rotate-2026-09-17.')
Write-Host 'Last step, in the browser: revoke the old key - the one ending ...sVQA - at'
Write-Host 'https://platform.openai.com/api-keys'
Write-Host ''
