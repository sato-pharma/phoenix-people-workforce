# =============================================================================
# slowness-sentinel-watch.ps1 - tell the owner on Telegram when the daily
# slowness check finds a limit crossed, or stops running.
#
# IT IS NOT A SECOND WATCHER, exactly like claude-scripts-backup-watch.ps1: the
# task reading, the log reading, the owner's chat, the de-duplication, the
# RECOVERED message and the never-throw discipline all live in
# worktree-snapshot-watch.ps1 and are driven by PHX_WS_* variables. This file
# only says WHICH job and in WHICH words (2026-10-09).
#
# slowness-sentinel.mjs writes one entry a day: "[time] OK window ..." or
# "[time] FAIL window ... PROBLEMS: <plain sentences>". A FAIL entry's PROBLEMS
# text is what reaches the phone. The sentinel exits 0 on a FAIL entry on
# purpose, so the watcher reads that text instead of a bare "exited 1".
#
# Pass-through: @args, so `slowness-sentinel-watch.ps1 --dry-run` prints the
# verdict and sends nothing.
# =============================================================================

if (-not $env:PHX_WS_TASK)      { $env:PHX_WS_TASK      = 'Phoenix Slowness Sentinel - Daily' }
if (-not $env:PHX_WS_SUBJECT)   { $env:PHX_WS_SUBJECT   = 'the daily slowness check' }
if (-not $env:PHX_WS_SNAPLOG)   { $env:PHX_WS_SNAPLOG   = Join-Path $env:USERPROFILE '.claude\scripts\slowness-sentinel.log' }
if (-not $env:PHX_WS_LOG)       { $env:PHX_WS_LOG       = Join-Path $env:USERPROFILE '.claude\scripts\slowness-sentinel-watch.log' }
if (-not $env:PHX_WS_STATE)     { $env:PHX_WS_STATE     = Join-Path $env:USERPROFILE '.claude\scripts\slowness-sentinel-watch.state' }
if (-not $env:PHX_WS_HEADLINE)  { $env:PHX_WS_HEADLINE  = 'Phoenix slowness alert' }
if (-not $env:PHX_WS_RUN)       { $env:PHX_WS_RUN       = 'daily slowness check' }
if (-not $env:PHX_WS_STOPPED)   { $env:PHX_WS_STOPPED   = 'nothing is watching Claude Code sessions for slowness' }
if (-not $env:PHX_WS_UNCERTAIN) { $env:PHX_WS_UNCERTAIN = 'whether sessions are being checked for slowness' }
if (-not $env:PHX_WS_STAKE)     { $env:PHX_WS_STAKE     = 'Nothing is broken or lost - Claude Code sessions are slower than the limits set on 9 October.' }
if (-not $env:PHX_WS_TAIL)      { $env:PHX_WS_TAIL      = 'To have it fixed, tell Claude: fix the slowness alarm from this morning.' }
if (-not $env:PHX_WS_RECOVERED) { $env:PHX_WS_RECOVERED = 'Yesterday''s Claude Code sessions were back within every slowness limit.' }

& (Join-Path $PSScriptRoot 'worktree-snapshot-watch.ps1') @args
