$envFilePath = Join-Path $PSScriptRoot "..\.env.local"
$cloudRunYamlPath = Join-Path $PSScriptRoot "..\cloud-run-env.yaml"

$lines = Get-Content $envFilePath

$nextPublicVars = @{}
$backendVars = @{}

foreach ($line in $lines) {
    if ($line.Trim() -eq "" -or $line.StartsWith("#")) {
        continue
    }

    $idx = $line.IndexOf("=")
    if ($idx -gt 0) {
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        
        # Remove surrounding quotes if they exist
        if ($value.StartsWith("`"") -and $value.EndsWith("`"") -and $value.Length -ge 2) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        # Skip Vercel specific vars as we are moving to GCP, but keep others
        if ($key.StartsWith("VERCEL_") -or $key.StartsWith("TURBO_")) {
            continue
        }

        # We'll push NEXT_PUBLIC_ variables to GitHub Secrets for build time
        if ($key.StartsWith("NEXT_PUBLIC_")) {
            $nextPublicVars[$key] = $value
        } else {
            # Everything else (including empty ones, or we can skip empty ones) goes to backend vars
            $backendVars[$key] = $value
        }
    }
}

Write-Host "Updating GitHub Secrets for NEXT_PUBLIC_ variables..."
foreach ($key in $nextPublicVars.Keys) {
    $val = $nextPublicVars[$key]
    Write-Host "Setting GitHub Secret: $key"
    $val | gh secret set $key
}

Write-Host "Generating Cloud Run env vars YAML..."
$yamlContent = @()
foreach ($key in $backendVars.Keys) {
    $val = $backendVars[$key]
    # Escape quotes for yaml
    $valEscaped = $val -replace '"', '\"'
    $yamlContent += "${key}: `"$valEscaped`""
}

$yamlContent | Set-Content $cloudRunYamlPath
Write-Host "Saved Cloud Run variables to $cloudRunYamlPath"

Write-Host "Updating Cloud Run service..."
gcloud run services update phoenix-hr --region europe-west3 --env-vars-file $cloudRunYamlPath

Write-Host "Done!"
