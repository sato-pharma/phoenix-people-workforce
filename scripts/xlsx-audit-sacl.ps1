# =============================================================================
# xlsx-audit-sacl.ps1 - the RECEIPT-GRADE version of the xlsx tripwire.
#
# RUN THIS YOURSELF, ELEVATED. Claude will not run it for you: it changes the
# machine's security audit policy, which is a system-settings change and outside
# what an assistant should do on your behalf. Everything it does is listed below
# and every part of it is undone by -Undo.
#
# WHY YOU MIGHT WANT IT. xlsx-tripwire.ps1 captures every process alive at the
# instant a file disappears, which is strong circumstantial evidence but not
# proof - it says "these 400 processes were running", not "this one did it".
# Windows object-access auditing writes the answer directly: Security event 4663
# names the process that opened the file for DELETE. That is the receipt.
#
# WHAT IT CHANGES - exactly three things:
#   1. Turns ON the "File System" audit subcategory (Success). Machine-wide
#      policy, but it only PRODUCES events where a SACL exists, and step 2 puts
#      SACLs on five folders. So the event volume is bounded by those folders,
#      not by the whole disk.
#   2. Adds an audit rule to each checkout's xlsx folder: Everyone, on Delete
#      and DeleteSubdirectoriesAndFiles, Success.
#   3. Nothing else. It does not change permissions - an audit rule (SACL)
#      controls what gets LOGGED, never who can do what.
#
# WHAT IT COSTS. Security log growth, only from those folders. If the log fills,
# Windows overwrites oldest-first by default; it does not block anything.
#
# HOW TO UNDO IT. .\xlsx-audit-sacl.ps1 -Undo   - removes every rule this script
# added and turns the subcategory back off. Do that once the culprit is named.
#
#   .\xlsx-audit-sacl.ps1          arm the audit
#   .\xlsx-audit-sacl.ps1 -Read    show what has been caught
#   .\xlsx-audit-sacl.ps1 -Undo    remove it all
# =============================================================================

[CmdletBinding()]
param(
  [switch]$Read,
  [switch]$Undo,
  [int]$Hours = 24,
  [string]$Repo = 'F:\Phoenix Workforce\phoenix-workforce'
)

$ErrorActionPreference = 'Stop'

function Test-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Elevated)) {
  Write-Host ''
  Write-Host 'REFUSED - this needs an ELEVATED PowerShell.' -ForegroundColor Yellow
  Write-Host 'Right-click PowerShell, "Run as administrator", then run it again from this folder.'
  Write-Host 'Nothing has been changed.'
  exit 2
}

# The folders to audit: every checkout's xlsx, discovered live rather than hard-coded,
# so a worktree added since this was written is covered too.
$folders = @()
foreach ($line in (& git -C $Repo worktree list --porcelain 2>$null)) {
  if ($line -like 'worktree *') {
    $x = Join-Path $line.Substring(9) 'xlsx'
    if (Test-Path -LiteralPath $x) { $folders += $x }
  }
}
if ($folders.Count -eq 0) {
  Write-Host "REFUSED - found no xlsx folder under $Repo. Wrong -Repo? Nothing changed." -ForegroundColor Yellow
  exit 3
}

# --- READ --------------------------------------------------------------------
if ($Read) {
  # Also write the findings to a plain file. The Security log needs elevation to
  # read, so anyone helping you diagnose this - Claude included - cannot see what
  # you just saw on screen. A file in .claude\scripts is readable without any
  # privilege, so the finding can actually leave this elevated window.
  $outFile = Join-Path $env:USERPROFILE '.claude\scripts\xlsx-audit-findings.txt'
  $report = New-Object System.Collections.Generic.List[string]
  function Say { param([string]$t, $Color = 'Gray')
    Write-Host $t -ForegroundColor $Color
    $report.Add($t)
  }

  Write-Host ''
  Say "Object-access events touching an xlsx folder, last $Hours h   (read $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))" 'Cyan'
  $since = (Get-Date).AddHours(-$Hours)
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4663; StartTime = $since } -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -match '\\xlsx\\' })

  # Whether the audit is ARMED is part of the finding, not a footnote. "No events"
  # means two opposite things and only this line tells them apart.
  $pol = (& auditpol /get /subcategory:"File System") -join ' '
  $armed = $pol -match 'Success'
  Say ("audit subcategory armed : {0}" -f $(if ($armed) { 'YES' } else { 'NO' })) $(if ($armed) { 'Green' } else { 'Yellow' })
  foreach ($f in $folders) {
    $rules = @((Get-Acl -LiteralPath $f -Audit).Audit | Where-Object { $_.IdentityReference.Value -match 'Everyone' })
    Say ("  SACL {0}  {1}" -f $(if ($rules.Count) { 'present' } else { 'MISSING' }), $f)
  }

  if ($events.Count -eq 0) {
    Say ''
    if ($armed) {
      Say '  No events. The audit IS armed, so this means nothing has been deleted since it was.' 'Green'
    } else {
      Say '  No events, and the audit is NOT armed - run this script with no switches first.' 'Yellow'
    }
  } else {
    foreach ($e in $events) {
      # 4663 carries the answer in its own properties: who, what file, which process.
      $p = @{}
      foreach ($d in ([xml]$e.ToXml()).Event.EventData.Data) { $p[$d.Name] = $d.'#text' }
      Say ''
      Say ("  {0}" -f $e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')) 'White'
      Say ("    file       : {0}" -f $p['ObjectName'])
      Say ("    accessed as: {0}  (0x10000 = DELETE)" -f $p['AccessMask'])
      Say ("    PROCESS    : {0}" -f $p['ProcessName']) 'Green'
      Say ("    pid        : {0}" -f $p['ProcessId'])
      Say ("    account    : {0}\{1}" -f $p['SubjectDomainName'], $p['SubjectUserName'])
    }
    Say ''
    Say ("  {0} event(s). The PROCESS line is the answer the tripwire could only circle." -f $events.Count) 'Cyan'
  }

  Set-Content -LiteralPath $outFile -Value $report -Encoding utf8
  Write-Host ''
  Write-Host "Written to $outFile - readable without elevation, so it can leave this window." -ForegroundColor Cyan
  exit 0
}

# --- UNDO --------------------------------------------------------------------
if ($Undo) {
  foreach ($f in $folders) {
    $acl = Get-Acl -LiteralPath $f -Audit
    $removed = 0
    foreach ($rule in @($acl.Audit)) {
      if ($rule.IdentityReference.Value -match 'Everyone') { [void]$acl.RemoveAuditRule($rule); $removed++ }
    }
    if ($removed -gt 0) { Set-Acl -LiteralPath $f -AclObject $acl }
    Write-Host ("removed {0} audit rule(s) from {1}" -f $removed, $f)
  }
  & auditpol /set /subcategory:"File System" /success:disable | Out-Null
  Write-Host 'File System audit subcategory turned OFF.' -ForegroundColor Green
  Write-Host 'Permissions were never touched, so nothing about access has changed.'
  exit 0
}

# --- ARM ---------------------------------------------------------------------
# The arm path writes a status file too, for the same reason -Read does: its output
# is trapped inside an elevated console nobody else can see, so "I ran it" cannot be
# checked by anyone but the person who ran it. Without this the only way to confirm
# an arm was to run -Read afterwards, which is a round trip for no reason.
$statusFile = Join-Path $env:USERPROFILE '.claude\scripts\xlsx-audit-status.txt'
$status = New-Object System.Collections.Generic.List[string]
function Note { param([string]$t, $Color = 'Gray')
  Write-Host $t -ForegroundColor $Color
  $status.Add($t)
}
$status.Add("armed at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') by $env:USERNAME")

& auditpol /set /subcategory:"File System" /success:enable | Out-Null
$pol = (& auditpol /get /subcategory:"File System") -join ' '
if ($pol -notmatch 'Success') {
  Note 'FAILED - the subcategory did not turn on. Nothing further was changed.' 'Red'
  Set-Content -LiteralPath $statusFile -Value $status -Encoding utf8
  exit 4
}
Note 'File System audit subcategory: Success ON' 'Green'

$rule = New-Object System.Security.AccessControl.FileSystemAuditRule(
  'Everyone',
  [System.Security.AccessControl.FileSystemRights]'Delete, DeleteSubdirectoriesAndFiles',
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AuditFlags]::Success)

foreach ($f in $folders) {
  $acl = Get-Acl -LiteralPath $f -Audit
  $acl.AddAuditRule($rule)
  Set-Acl -LiteralPath $f -AclObject $acl
  # Verify by READING IT BACK. A Set-Acl that silently did nothing would leave you
  # believing you are recording, which is worse than knowing you are not.
  $back = @((Get-Acl -LiteralPath $f -Audit).Audit | Where-Object { $_.IdentityReference.Value -match 'Everyone' })
  if ($back.Count -gt 0) {
    Note ("  armed   {0}" -f $f) 'Green'
  } else {
    Note ("  FAILED to arm {0} - rule did not stick" -f $f) 'Red'
  }
}

Set-Content -LiteralPath $statusFile -Value $status -Encoding utf8
Write-Host ''
Write-Host 'Armed. From now on, any delete in those folders writes Security event 4663' -ForegroundColor Cyan
Write-Host 'naming the process. Read it with:  .\xlsx-audit-sacl.ps1 -Read'
Write-Host 'Turn it all off again with:        .\xlsx-audit-sacl.ps1 -Undo'
Write-Host "Status written to $statusFile" -ForegroundColor Cyan
