---
name: there-is-only-one-disk-so-no-local-backup-covers-a-disk-failure
description: "C: and F: are two partitions of ONE physical NVMe (disk 0, PM981a Samsung 512GB), so F:\\PHX backup, the hourly xlsx copy and any scratchpad archive protect against a git clean, reset, stash -u or worktree removal and NEVER against a disk failure — the only off-machine copy is a push to GitHub; never tell him a local copy makes work safe from losing the disk."
metadata:
  node_type: memory
  type: project
  originSessionId: 1baaa0f5-9436-457f-8907-da9439516d28
  modified: 2026-10-04T04:21:58.761Z
---

Measured 2026-10-04 while copying another session's uncommitted work to `F:\PHX backup`:

```
DriveLetter DiskNumber SizeGB      Number FriendlyName              SizeGB HealthStatus
C           0          293         0      PM981a NVMe Samsung 512GB 477    Healthy
F           0          41
```

**One disk. Two partitions.** `C:` had 38.8 GB free, `F:` 15.6 GB.

So every backup path this repo and this machine use — `F:\PHX backup\05-data-files` (the hourly
`xlsx/` copy), `F:\Claude Scratchpad Archive\`, `~/.claude/backups/`, and anything written to `C:` —
sits on the same device as the work it is protecting.

**What a local copy genuinely buys:** it survives a `git clean`, `reset --hard`, `stash -u`,
`checkout --`, a worktree removal, Storage Sense emptying Temp, and a session's own mistake. Those
are the losses that actually happen here, so the copies are worth making.

**What it cannot buy:** surviving the loss of the disk. The ONLY off-machine copy of anything is a
push to GitHub — which for another session's branch is that session's own call, never yours to make.

🔴 **So never phrase a local backup as protection from a disk failure.** I told the owner a copy
would mean "a disk failure does not take them", then measured the disks and had to correct it in the
same task. Say what it protects against, and name the push as the only real off-machine option.

**A second thing measured in the same task:** an uncommitted-file count goes stale within minutes,
because the other sessions are live. `_wt-perf-remaining` read **19** files when I measured it and
**30** by the time I copied, and `_wt-headwind-upload-limit` went from 3 uncommitted files to 0 plus
one unpushed commit — it committed while I worked. So a snapshot is a snapshot of one instant: say
the instant, and capture unpushed COMMITS too (`git bundle create <out> origin/main..HEAD` is
read-only — it creates no ref and moves no branch), because copying working-tree files misses them
entirely.

Related: [[xlsx-hourly-backup-has-holes]] if it exists, and
[[fast-forwarding-a-live-dev-servers-folder-trips-the-8gb-runaway-kill]] — both are about this same
machine's one disk and its live sessions.
