---
name: the-phx-backup-drive-is-the-same-physical-disk
description: "E:\\PHX backup (behind the F:\\PHX backup junction) sits on the SAME Samsung NVMe as C:, D: and F: — it survives a deletion, never a disk failure; its 05-data-files folder vanished 11 Nov and was recreated 19 Nov"
metadata:
  node_type: memory
  type: project
  originSessionId: 844c1fd4-8065-4530-8f82-2fbfac33dc90
  modified: 2026-11-19T00:49:56.695Z
---

Measured 2026-11-19 02:50 Cairo with `Get-Partition` / `Get-Disk`: C:, D:, E: and F: are all partitions of disk 0, the one
PM981a NVMe Samsung 512 GB. `F:\PHX backup` is a junction to `E:\PHX backup` (made 18 Oct). So every copy in that set —
the hourly spreadsheet snapshot in `05-data-files`, `08-worktree-uncommitted` — protects against a deletion sweep (the
2026-09-05 PDF incident), never against the disk dying. The only off-machine copy of anything on this laptop is a push to
GitHub (`laptop/claude-scripts` for `~/.claude` source). The ~419 untracked spreadsheets in `xlsx/` have NO off-machine copy.

`E:\PHX backup\05-data-files` disappeared about 11 Nov 23:30 Cairo (the snapshot refused 147 times, exit 2, while Task
Scheduler showed the task as run). No session transcript shows it being removed or moved, and no `xlsx-snapshot-*` folder
exists anywhere on C:, D:, E: or F: within five levels — the history before 19 Nov is gone. Recreated empty 19 Nov 02:47
Cairo; the next run copied 419 files, all verified by SHA256, into `xlsx-snapshot-2026-11-19`.

**Why:** a "backup" on the same disk reads as safe and is not; and a vanished destination is only visible in the log.
**How to apply:** never call the PHX backup set off-disk or a disaster-recovery copy. When the snapshot log says
`REFUSED — ... does not exist`, check that `E:\PHX backup` itself is there (the drive) before recreating the subfolder —
the refusal exists to stop writing onto the wrong disk, so never make the script create it.
