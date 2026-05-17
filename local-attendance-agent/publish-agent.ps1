param(
  [ValidateSet("win-x86", "win-x64")]
  [string]$Runtime = "win-x86",
  [switch]$SelfContained
)

$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectPath = Join-Path $AgentRoot "Phoenix.Attendance.Agent.csproj"
$NuGetConfigPath = Join-Path $AgentRoot "NuGet.Config"
$OutputPath = Join-Path $AgentRoot "publish\$Runtime"
$SelfContainedValue = if ($SelfContained) { "true" } else { "false" }
$DotnetHome = Join-Path $AgentRoot ".dotnet-home"
$NuGetRoot = Join-Path $AgentRoot ".nuget"
$AppDataRoot = Join-Path $AgentRoot ".appdata"

New-Item -ItemType Directory -Path $DotnetHome -Force | Out-Null
New-Item -ItemType Directory -Path $NuGetRoot -Force | Out-Null
New-Item -ItemType Directory -Path $AppDataRoot -Force | Out-Null
$env:DOTNET_CLI_HOME = $DotnetHome
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$env:NUGET_PACKAGES = Join-Path $NuGetRoot "packages"
$env:NUGET_HTTP_CACHE_PATH = Join-Path $NuGetRoot "http-cache"
$env:NUGET_PLUGINS_CACHE_PATH = Join-Path $NuGetRoot "plugins-cache"
$env:APPDATA = Join-Path $AppDataRoot "Roaming"
$env:LOCALAPPDATA = Join-Path $AppDataRoot "Local"

Write-Host "[attendance-agent] Restoring for $Runtime"
dotnet restore $ProjectPath -r $Runtime --configfile $NuGetConfigPath
if ($LASTEXITCODE -ne 0) { throw "dotnet restore failed." }

if (Test-Path $OutputPath) {
  $resolvedAgentRoot = (Resolve-Path $AgentRoot).Path
  $resolvedOutputPath = (Resolve-Path $OutputPath).Path
  if (-not $resolvedOutputPath.StartsWith($resolvedAgentRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean publish output outside the agent folder: $resolvedOutputPath"
  }
  Write-Host "[attendance-agent] Cleaning $OutputPath"
  Remove-Item -LiteralPath $OutputPath -Recurse -Force
}

Write-Host "[attendance-agent] Publishing $Runtime self-contained=$SelfContainedValue"
dotnet publish $ProjectPath -c Release -r $Runtime --self-contained $SelfContainedValue --no-restore -o $OutputPath
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed." }

Write-Host "[attendance-agent] Published executable:"
Write-Host "  $OutputPath\Phoenix.Attendance.Agent.exe"
