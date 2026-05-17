param(
  [Parameter(Mandatory)]
  [string]$File
)

if (!(Test-Path $File)) {
  Write-Error "File not found: $File"
  exit 1
}

& supabase db query --file $File --local | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "ssql fallback: direct query failed (multi-statement SQL). Applying pending migrations..."
  & supabase migration up --local --include-all --yes
} else {
  Write-Host "ssql: executed successfully via supabase db query --file"
}
