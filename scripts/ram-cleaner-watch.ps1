# ram-cleaner-watch.ps1 - tell the owner on Telegram when the RAM cleaner stops working
# (owner, 2026-11-19: "fix all findings in an automated way").
#
# Same design and the same shared engine as the backup alerts (worktree-snapshot-watch.ps1):
# it judges the TASK (missing, disabled, unreadable, a bad exit code - a run killed mid-way
# never reaches its own log) and the cleaner's last "[time] FAIL ..." log entry. One message
# per fault, repeated only after the engine's repeat window, and one RECOVERED message.
# Like the backup alerts it does NOT alarm on missed runs: the laptop sleeps.
#
#   ram-cleaner-watch.ps1 --dry-run   prints the verdict, sends nothing
# Runs hourly from the task "Phoenix RAM Cleaner - Failure Alert".

if (-not $env:PHX_WS_TASK)      { $env:PHX_WS_TASK      = 'Phoenix RAM Cleaner - Every 5 Min' }
if (-not $env:PHX_WS_SUBJECT)   { $env:PHX_WS_SUBJECT   = 'the laptop RAM' }
if (-not $env:PHX_WS_SNAPLOG)   { $env:PHX_WS_SNAPLOG   = 'C:\ProgramData\PhoenixRamCleaner\ram-cleaner.log' }
if (-not $env:PHX_WS_LOG)       { $env:PHX_WS_LOG       = Join-Path $env:USERPROFILE '.claude\scripts\ram-cleaner-watch.log' }
if (-not $env:PHX_WS_STATE)     { $env:PHX_WS_STATE     = Join-Path $env:USERPROFILE '.claude\scripts\ram-cleaner-watch.state' }
if (-not $env:PHX_WS_HEADLINE)  { $env:PHX_WS_HEADLINE  = 'Phoenix RAM cleaner alert' }
if (-not $env:PHX_WS_RUN)       { $env:PHX_WS_RUN       = 'RAM cleaner run' }
if (-not $env:PHX_WS_STOPPED)   { $env:PHX_WS_STOPPED   = 'idle programs are no longer being trimmed and free RAM will drift back toward the floor' }
if (-not $env:PHX_WS_UNCERTAIN) { $env:PHX_WS_UNCERTAIN = 'whether the RAM cleaner is still freeing memory' }
if (-not $env:PHX_WS_STAKE)     { $env:PHX_WS_STAKE     = 'Nothing is lost - no session or file is touched - but without it free RAM fell to about 400 MB on 19 Nov, where the laptop freezes.' }
if (-not $env:PHX_WS_TAIL)      { $env:PHX_WS_TAIL      = 'Tell Claude "fix the RAM cleaner" - the reason is in C:\ProgramData\PhoenixRamCleaner\ram-cleaner.log.' }
if (-not $env:PHX_WS_RECOVERED) { $env:PHX_WS_RECOVERED = 'The RAM cleaner is running cleanly every 5 minutes again.' }

& (Join-Path $PSScriptRoot 'worktree-snapshot-watch.ps1') @args
