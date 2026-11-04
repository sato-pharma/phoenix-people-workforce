# ~/.claude source, backed up off the machine

**This branch is a BACKUP, not a change. Never merge it and never open a pull request from it.**

It holds the scripts and hooks that live in `~/.claude/` on the owner's laptop — the memory
watchdog, the xlsx tripwire, the two snapshot watchers, the dev-server reaper, the status line,
every PreToolUse guard. None of them is part of the product and none of them runs from this
repository; they are here because of one measured fact: **C: and F: are two partitions of one
physical NVMe**, so every local backup path sits on the same device as the work it protects, and
a push to GitHub is the only off-machine copy that exists.

## Why it is a branch and not a folder on `main`

`ci.yml` triggers on `pull_request` and `push: branches: [main]` only, so a push here runs no
workflow and bills no Actions minutes. It also keeps laptop-only PowerShell out of `main`, out of
every worktree and out of every cloud clone.

## What is deliberately NOT here

- `.log` files and the `xlsx-tripwire-procs-*.txt` dumps — those carry full process command
  lines, which is exactly where a token ends up.
- `.json` by GLOB — `.credentials.json` and the MCP caches live under `~/.claude`, and a glob is
  a bad place to be approximately right. Two travel because they are NAMED and were read field
  by field: `settings.json` (2026-10-09) and `hooks/dispatch.json` (2026-10-15), the table every
  blocking user-level PreToolUse guard is reached through — without it a restore brings the
  guards back DISARMED, silently.
- the memory folder — it is business data, and `scripts/sync-cloud-context.mjs` mirrors it into
  `main`. `~/.claude/CLAUDE.md` used to be left to that mirror too and is now carried here as
  well: nothing schedules the mirror, so it is only as fresh as the last session that ran it.

Every file is gated before it is written: a literal-secret shape or a NUL byte in any candidate
aborts the whole run and pushes nothing.

## Restoring

```
git fetch origin laptop/claude-scripts
git show origin/laptop/claude-scripts:scripts/mem-watchdog.ps1 > mem-watchdog.ps1
```

Written by `~/.claude/scripts/claude-scripts-backup.mjs`, which is itself in here.

`git log -1 --date=local origin/laptop/claude-scripts` says when this was last taken; no
timestamp is written into these files on purpose, so an hour with no change pushes nothing.
