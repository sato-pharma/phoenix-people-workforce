# =============================================================================
# claude-scripts-backup-watch.ps1 - tell the owner on Telegram when the hourly
# off-machine backup of ~/.claude stops working.
#
# IT IS NOT A SECOND WATCHER. Everything about watching a scheduled backup -
# reading the task, judging its result, reading the backup's own log, resolving
# the owner's chat, de-duplicating a standing fault, the RECOVERED message, the
# never-throw discipline - is already in worktree-snapshot-watch.ps1, and all of
# it is driven by PHX_WS_* environment variables for exactly this reason. This
# file is the five lines that say WHICH backup, so a fix to the logic is made
# once instead of drifting between near-copies.
#
# A scheduled task cannot carry environment variables of its own, which is why
# this is a file rather than a -Command string: the quoting chain through
# conhost -> powershell -> -Command is the kind of thing that breaks silently
# months later, and this is readable.
#
# Pass-through: @args, so `claude-scripts-backup-watch.ps1 --dry-run` prints the
# verdict and sends nothing. That is the right first command when diagnosing it.
# =============================================================================

# Each is set only if it is not already set, so a fixture can still be pushed
# through THIS file - the one that actually runs - instead of through a copy of
# its logic. A wrapper that clobbers its own parameters cannot be tested, which
# defeats the point of them being parameters (caught 2026-10-04 doing exactly
# that: a fixture log ending in a real failure read healthy through here).
if (-not $env:PHX_WS_TASK)    { $env:PHX_WS_TASK    = 'Phoenix Claude Scripts Backup - Hourly' }
if (-not $env:PHX_WS_SUBJECT) { $env:PHX_WS_SUBJECT = 'the ~/.claude scripts and hooks' }
if (-not $env:PHX_WS_SNAPLOG) { $env:PHX_WS_SNAPLOG = Join-Path $env:USERPROFILE '.claude\scripts\claude-scripts-backup.log' }
if (-not $env:PHX_WS_LOG)     { $env:PHX_WS_LOG     = Join-Path $env:USERPROFILE '.claude\scripts\claude-scripts-backup-watch.log' }
if (-not $env:PHX_WS_STATE)   { $env:PHX_WS_STATE   = Join-Path $env:USERPROFILE '.claude\scripts\claude-scripts-backup-watch.state' }

# NOT "the only copy there is" - that is the worktree snapshot's stake, not this
# one. These scripts are still on the disk while the backup is stopped; what a
# silent stop costs is the ONLY copy that survives losing the disk, and C: and F:
# are two partitions of one NVMe.
if (-not $env:PHX_WS_STAKE) { $env:PHX_WS_STAKE = 'The scripts are still on the laptop - what has stopped is the only copy of them that would survive losing the disk, and C: and F: are two partitions of the same one.' }

& (Join-Path $PSScriptRoot 'worktree-snapshot-watch.ps1') @args
