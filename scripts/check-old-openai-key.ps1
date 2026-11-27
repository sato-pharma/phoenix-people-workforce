$ErrorActionPreference = 'Stop'
# Asks OpenAI whether the OLD key still works. Prints only an HTTP status, never a value.
# Reads the old key from the rotation backup if it exists, otherwise from the live .env.local
# (which still holds it until the rotation runs), otherwise from the encrypted 2026-09-17 copy.
$candidates = @(
  'F:\Phoenix Workforce\phoenix-workforce\.env.local.bak-openai-rotate-2026-09-17',
  'F:\Phoenix Workforce\phoenix-workforce\.env.local'
)
$sha = [System.Security.Cryptography.SHA256]::Create()
$enc = [Text.Encoding]::UTF8
$old = $null
foreach ($f in $candidates) {
  if (-not (Test-Path $f)) { continue }
  $line = @([IO.File]::ReadAllText($f) -split "`r?`n" | Where-Object { $_ -match '^\s*OPENAI_API_KEY\s*=' })[0]
  if (-not $line) { continue }
  $v = $line -replace '^\s*OPENAI_API_KEY\s*=\s*', ''
  $fp = [BitConverter]::ToString($sha.ComputeHash($enc.GetBytes($v))).Replace('-','').Substring(0,8)
  if ($fp -eq '469EBD3D') { $old = $v; Write-Output ('old key found in : ' + (Split-Path $f -Leaf)); break }
}
if (-not $old) {
  $bak = Join-Path $HOME '.secrets\windows-user-env-credentials-2026-09-17.dpapi.json'
  $j = Get-Content $bak -Raw | ConvertFrom-Json
  $sec = ConvertTo-SecureString $j.OPENAI_API_KEY
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  $old = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
  Write-Output 'old key found in : the encrypted backup'
}
try {
  $r = Invoke-WebRequest -Uri 'https://api.openai.com/v1/models' -Headers @{ Authorization = ('Bearer ' + $old) } -UseBasicParsing -TimeoutSec 30
  Write-Output ('old key (...sVQA) : HTTP ' + [int]$r.StatusCode + ' - STILL LIVE, revoke it at platform.openai.com/api-keys')
} catch {
  $code = 'no response'
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  if ("$code" -eq '401') { Write-Output 'old key (...sVQA) : HTTP 401 - revoked, it can no longer be used' }
  else { Write-Output ('old key (...sVQA) : HTTP ' + $code) }
}
$old = $null
