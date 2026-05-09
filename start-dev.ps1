param(
    [int]$Port = 3001,
    [switch]$ClearCache = $false,
    [string]$ProjectRoot = "$PSScriptRoot"
)

$ErrorActionPreference = "Stop"

function Get-OwnerPidsOnPort {
    param([int]$ListenPort)
    $connections = Get-NetTCPConnection -State Listen -LocalPort $ListenPort -ErrorAction SilentlyContinue
    if (-not $connections) {
        return @()
    }
    return $connections | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique
}

function Stop-ProcIfExists {
    param([int[]]$Pids)
    foreach ($pid in $Pids) {
        if ($pid -le 0) { continue }
        try {
            Stop-Process -Id $pid -Force -ErrorAction Stop
            Write-Host "Stopped process $pid on reserved port."
        } catch {
            # process may have exited already
        }
    }
}

Set-Location $ProjectRoot

if (-not (Test-Path "package.json")) {
    throw "package.json not found. Run this script from the project root."
}

$pids = Get-OwnerPidsOnPort -ListenPort $Port
if ($pids.Count -gt 0) {
    Write-Host "Existing listeners found on port $Port, stopping..."
    Stop-ProcIfExists -Pids $pids
    Start-Sleep -Seconds 1
}

if ($ClearCache -and (Test-Path ".next")) {
    Write-Host "Removing .next cache..."
    Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
}

$devCommand = "npm.cmd run dev -- -p $Port"
Write-Host "Starting: $devCommand"
Write-Host "Working directory: $ProjectRoot"

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
$psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command `$ProgressPreference='SilentlyContinue'; Set-Location '$ProjectRoot'; $devCommand"
$psi.WorkingDirectory = $ProjectRoot
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true

$paths = @(
    [Environment]::GetEnvironmentVariable("Path", "Machine"),
    [Environment]::GetEnvironmentVariable("Path", "User")
)
$psi.Environment["Path"] = ($paths -join ";") -replace ";;", ";"

$process = [System.Diagnostics.Process]::Start($psi)
Start-Sleep -Seconds 2

if ($process.HasExited) {
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    Write-Error "Dev server exited immediately."
    if ($stdout) { Write-Host $stdout }
    if ($stderr) { Write-Host $stderr }
    exit 1
}

Write-Host "Dev server running. PID: $($process.Id)"
Write-Host "Open: http://localhost:$Port/offers"
