$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectPath = Join-Path $AgentRoot "Phoenix.Attendance.Agent.csproj"
$NuGetConfigPath = Join-Path $AgentRoot "NuGet.Config"
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

Write-Host "[attendance-agent] Restoring"
dotnet restore $ProjectPath --configfile $NuGetConfigPath
if ($LASTEXITCODE -ne 0) { throw "dotnet restore failed." }

Write-Host "[attendance-agent] Building Release"
dotnet build $ProjectPath -c Release --no-restore
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed." }
