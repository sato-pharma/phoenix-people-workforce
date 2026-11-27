# Hourly wrapper for the scheduled task "Claude Account Session Import - Hourly".
#
# It brings the UNFINISHED sessions of the other Claude accounts on this machine into the
# account the desktop app is signed into. The importer itself is quiet: it prints only when
# it actually copies something. This wrapper always stamps a heartbeat so "did it run?" is
# answerable without reading the import log, and logs a line — with the importer's own
# stderr — whenever a run fails.
#
#   heartbeat : ~/.claude/scripts/account-session-import.alive
#   imports    : ~/.claude/scripts/account-session-import.log
#
# node is invoked through Start-Process with both streams redirected to files on purpose.
# In Windows PowerShell 5.1, `& native 2>&1` wraps every stderr line in an ErrorRecord and
# flips $? even on exit 0 — so the one thing needed to diagnose a failed run is exactly the
# thing the obvious spelling destroys.

$node = 'C:\Program Files\nodejs\node.exe'
$script = Join-Path $env:USERPROFILE '.claude\scripts\import-account-sessions.mjs'
$log = Join-Path $env:USERPROFILE '.claude\scripts\account-session-import.log'
$alive = Join-Path $env:USERPROFILE '.claude\scripts\account-session-import.alive'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'

function Stop-Run([string]$why, [int]$code) {
  Add-Content -LiteralPath $log -Value "[$stamp] FAILED - $why" -Encoding utf8
  Set-Content -LiteralPath $alive -Value "$stamp FAILED - $why" -Encoding utf8
  exit $code
}

if (-not (Test-Path -LiteralPath $node)) { Stop-Run "node is not at $node" 1 }
if (-not (Test-Path -LiteralPath $script)) { Stop-Run "importer missing at $script" 1 }

$outFile = Join-Path $env:TEMP 'account-session-import.out'
$errFile = Join-Path $env:TEMP 'account-session-import.err'

$p = Start-Process -FilePath $node -ArgumentList @($script, '--apply', '--quiet') `
  -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
$code = $p.ExitCode

# node writes UTF-8; without -Encoding UTF8 the default ANSI read turns an em-dash in an
# account name into mojibake in the heartbeat.
$out = (Get-Content -LiteralPath $outFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
$err = (Get-Content -LiteralPath $errFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
if ($out) { $out = $out.Trim() }
if ($err) { $err = $err.Trim() }

if ($code -ne 0) { Stop-Run "exit $code - $err$out" $code }

$brought = if ($out) { $out } else { 'nothing new' }
Set-Content -LiteralPath $alive -Value "$stamp ok - $brought" -Encoding utf8
exit 0
