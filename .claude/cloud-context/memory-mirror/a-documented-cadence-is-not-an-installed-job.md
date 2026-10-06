---
name: a-documented-cadence-is-not-an-installed-job
description: "A schedule stated in AGENTS.md, a doc or a memory index is a DESCRIPTION, not a job — the 3x/day memory fold was documented from 2026-10-03 and installed nowhere until 2026-10-06, naming a task and a worktree that both did not exist; before relying on any recurring job, ask the scheduler by name and read its lastRunTime."
metadata:
  node_type: memory
  type: project
  originSessionId: 02b15773-349d-45f7-b725-9ffb4deee410
  modified: 2026-10-06T18:56:48.514Z
---

`AGENTS.md` §2.2, the global standing rules and `MEMORY.md` all said the memory fold "runs three
times a day — 09:00, 15:00 and 21:00 Cairo". `docs/module-memory.md` went further and named the
mechanism: a laptop task **`module-memory-fold`** with cron `0 9,15,21 * * *`, running from a
detached worktree **`_wt-memory-fold-runner`**.

**Neither existed.** Measured 2026-10-06: no Windows scheduled task mentioned `fold`, `run-nightly`
or `module-memory` in its arguments; no task triggered at 15:00 at all; no Claude scheduled task;
no workflow cron. The only 21:00 task on the box, **Phoenix CRM field day report**, runs
`~/.claude/scripts/field-day-nightly.mjs`, which names `fold.mjs` only in a comment about borrowing
its throwaway-worktree pattern.

So for three days every new note sat in the `MEMORY.md` inbox — re-charging every request in every
session — and reached its module only when a session happened to run `fold.mjs --apply` by hand.
Nothing reported it: the fold has no monitor, and a job that was never installed produces no error.

**How to apply.** Before saying a recurring job runs, or waiting for one, ask the scheduler and read
the result, never a doc:

```powershell
Get-ScheduledTask | ForEach-Object { $n=$_.TaskName; foreach ($a in $_.Actions) { if ($a.Arguments -match '<script>') { "$n  $($a.Arguments)" } } }
Get-ScheduledTask -TaskName '<name>' | Get-ScheduledTaskInfo   # LastRunTime, LastTaskResult, NextRunTime
```

A task's **Arguments** are what it actually runs; its **name** can say anything. `LastTaskResult`
`267011` means it has never run, and `0` is the only success. The two scheduled-job families on this
machine are Windows tasks (`Get-ScheduledTask`) and Claude's own
(`mcp__scheduled-tasks__list_scheduled_tasks`) — check both, plus `.github/workflows` crons for
anything that could live in CI.

The fold is now really installed: Windows task **`Phoenix memory fold`**, three weekly triggers
Monday–Saturday (never `-Daily`, which fires on the Sunday he excluded), from
`scripts/module-memory/install-fold-task.ps1`, logging to
`~/.claude/scripts/memory-fold-task.log`, pinned by `tests/memory-fold-task.test.ts`.

See [[a-manual-scheduled-task-run-leaves-no-trace]] and
[[verify-the-emitted-artifact-never-the-source]].
