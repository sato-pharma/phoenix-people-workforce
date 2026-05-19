$ErrorActionPreference = "Stop"

$AgentRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartScript = Join-Path $AgentRoot "start-agent.ps1"
$StartupFolder = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $StartupFolder "Phoenix Attendance Agent.lnk"

if (-not (Test-Path $StartScript)) {
  throw "Missing $StartScript"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`" -SkipPrereqInstall"
$shortcut.WorkingDirectory = $AgentRoot
$shortcut.Description = "Starts the Phoenix local fingerprint attendance agent."
$shortcut.Save()

Write-Host "[attendance-agent] Startup shortcut installed:"
Write-Host "  $ShortcutPath"
