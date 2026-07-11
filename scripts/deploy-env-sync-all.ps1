$envFilePath = Join-Path $PSScriptRoot "..\.env.local"
$cloudRunYamlPath = Join-Path $PSScriptRoot "..\cloud-run-env-all.yaml"

$lines = Get-Content $envFilePath
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

        # Skip Vercel specific vars
        if ($key.StartsWith("VERCEL_") -or $key.StartsWith("TURBO_")) {
            continue
        }

        # Add EVERYTHING to backend vars (including NEXT_PUBLIC)
        $backendVars[$key] = $value
    }
}

Write-Host "Generating Cloud Run env vars YAML with ALL variables..."
$yamlContent = @()
foreach ($key in $backendVars.Keys) {
    $val = $backendVars[$key]
    $valEscaped = $val -replace '"', '\"'
    $yamlContent += "${key}: `"$valEscaped`""
}

$yamlContent | Set-Content $cloudRunYamlPath
Write-Host "Saved Cloud Run variables to $cloudRunYamlPath"

Write-Host "Updating Cloud Run service..."
gcloud run services update phoenix-hr --region us-central1 --env-vars-file $cloudRunYamlPath
Write-Host "Done!"
