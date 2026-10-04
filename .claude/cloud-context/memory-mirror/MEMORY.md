# Memory Index

**Module memory holds everything module-specific** — `.claude/rules/<module>.md` in the repo, loaded when a session works in that module (AGENTS.md §2.2, docs/module-memory.md). This index holds what is true everywhere, plus the inbox. Nothing is trimmed from it any more.

**Hooks only - the FILE is the fact. Rules: `AGENTS.md` §2.2.**
- [ARCHIVE](MEMORY-ARCHIVE.md) - the pre-2026-10-02 archive; every note in it is now filed in a module.

## 🥇 RULE #1 - never trim, never forget
- 🔴 [**`B-10` is the OWNER himself**](b-10-is-the-owner-himself.md) - sole Super Admin, so EVERY `decided_by` is his. Never advise him to "tell B-10" or notify him of his own decisions.
- 🔴 [**Monthly Closing** = the ONLY sales+target truth](sos-monthly-closing-is-the-only-sales-truth.md) - every surface reads ITS sales AND target (targets confirmed 2026-09-27); Weekly excluded; Marketing ROI the ONE exception.
- 🔒 [Head Office is in NEITHER weekly NOR monthly - unmapped is CORRECT](head-office-products-are-not-tracked-weekly-golden-rule.md) - tracked = **CNS · Anti Infective · Pedia** ONLY; HO is **90% of weekly VALUE**. NEVER flag or map it; ALWAYS filter before quoting a number.
- 🔒 [Lacto: family NAMES split; family_code still shared](lacto-advanced-and-basic-share-family-and-family-code.md) - `Lacto Advanced` (Pedia) + `Lacto Basic` (HO); no bare `Lacto`. **Both keep family_code=`LA` DELIBERATELY** - the direct-order basket allow-list; tidying it un-combines the order.
- 🔴 [NEVER add units of different products/concentrations](units-of-different-products-are-never-added.md) - a unit total is valid for ONE product_code only; above that aggregate by **VALUE**. Same for TARGET units.
- 🔴 [Head Office is ABSENT from `phx_monthly_achievement`](head-office-sales-are-absent-from-phx-monthly-achievement.md) - no rows ≠ zero: it rendered real July units as 0. Royanoxicam DOES return (line NULL), Lacto Basic and Satoslim do not. `direct_value` is NOT the sales value; HO has NO price, units only.
- 🔴 Pre-July: [reconcile per customer×product](closing-reconcile-per-customer-product-not-area-pre-july.md)·[CURRENT price + backfill targets](closing-pre-july-revalue-and-backfill-targets-at-phoenix-price.md)
- 🔴 [a price fix RESTATES every published month](a-price-fix-silently-restates-every-published-closing.md) - INTENDED; drift sees VALUE now, price outside the lock. **July AI stays as published (owner).**·🔒 [the matrix can NEVER fit; summary ships BESIDE it](monthly-closing-matrix-cannot-fit.md) - leave the scroll.

## In flight
- 🔴 Email: [NEVER bulk/test sends](never-fire-bulk-emails-ever.md)·[both cuts LIVE](email-inventory-audit-2026-08-13.md) - probation email OFF **except Day 30/60/75 → Yasmeena, cc B-10**·[every automated email ALSO pings his Telegram](every-automated-email-also-mirrors-to-the-admin-telegram.md) - a test send reaches him.

## Owner's rules (don't "fix" back)
- 🔴 [the Next step box is NOT a notepad](the-next-step-box-must-not-manufacture-the-next-task.md) - he SENDS what is in it. Never a task Claude invented; a shipped feature is DONE.
- 🔴 [hand HIM PowerShell, never bash](commands-handed-to-the-owner-must-be-powershell.md) - his Terminal rejects `&&` before anything runs.
- 🔴 [fix means fix - no unrequested work](fix-means-fix-no-unrequested-work.md)
- 🔴 [NEVER approve for the CEO](never-approve-for-the-ceo.md) - he INTERRUPTED his own "approve them both". The work up to the decision is mine; the decision is his.

## Traps that bite any session
- 🔴 **Never re-add a module fact here or to `AGENTS.md`** - it goes in that module's `.claude/rules/<module>.md`; session traps live in §2.1's clusters.


## Inbox — new notes land here
Put each new memory note's pointer here, one line. The fold (`node scripts/module-memory/fold.mjs --apply`, three times a day — 09:00, 15:00 and 21:00 Cairo) files it under its module in ONE PR; once that merges, the next fold removes the line.
- [ONE disk - no local backup survives losing it](there-is-only-one-disk-so-no-local-backup-covers-a-disk-failure.md) - C: and F: are two partitions of disk 0 (PM981a 512GB), so `F:\PHX backup`, the hourly xlsx copy and the scratchpad archive cover a `git clean`/`reset`/`stash -u`/worktree removal and NEVER a disk failure; the only off-machine copy is a push. An uncommitted-file count also goes stale in minutes (19 read, 30 copied) - say the instant, and bundle unpushed COMMITS too.
- [uncommitted worktree work is snapshotted HOURLY](uncommitted-worktree-work-is-snapshotted-hourly.md) - `~/.claude/scripts/worktree-uncommitted-snapshot.mjs` + task `Phoenix Worktree Snapshot - Hourly` copies every uncommitted file and unpushed commit of every worktree to `F:\PHX backup\08-worktree-uncommitted`; content-addressed, NEVER deletes, read-only, frozen paths skipped. A failure now reaches him on Telegram - `worktree-snapshot-watch.ps1`, task `Phoenix Worktree Snapshot - Failure Alert`, hourly; `--dry-run` reads the verdict without sending.
- [a task's `LastTaskResult` of 0 can be `[int64]$null`](get-scheduledtaskinfo-without-taskpath-can-return-null-and-read-as-healthy.md) - `Get-ScheduledTaskInfo` WITHOUT `-TaskPath '\'` intermittently throws ERROR_INVALID_NAME for a healthy task, and SilentlyContinue turns that into `0` = success, so a watchdog calls a DEAD task healthy. A blank `LastRunTime` beside a confident `0x0` is the tell; unreadable is a FAULT, not all clear. Fixed in both snapshot watchers.
- [archiving a session does NOT remove its `.claude/worktrees` folder](archiving-a-session-does-not-remove-its-claude-worktrees-folder.md) - `archive_session` left it standing and `new-session.mjs --remove` refuses it. Worked: archive-ref the tip, `cmd /c rmdir` the node_modules junction, `git worktree remove`, name the holder with find-worktree-holder.ps1, stop only that idle shell after matching start time + parent, delete, `git branch -D`.
