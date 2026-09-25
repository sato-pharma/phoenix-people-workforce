---
name: a-manual-scheduled-task-run-leaves-no-trace
description: "A scheduled task started with Run now records no lastRunAt and creates no session in list_sessions — so both being absent is NOT evidence the run failed, and the task stays armed for its scheduled fire"
metadata:
  node_type: memory
  type: feedback
  originSessionId: eceeac7a-1110-48d5-9c83-7f471e16500d
  modified: 2026-09-08T05:56:42.742Z
---

**A manually-triggered scheduled task ("Run now" in the Scheduled sidebar) leaves none of the traces
a scheduled fire leaves.** `list_scheduled_tasks` shows no `lastRunAt` for it, and
`list_sessions` shows no session for it either. Both absences are normal. Neither is evidence that
the run did not happen.

Confirmed 2026-09-08 on `cv-lifecycle-rotation-friday-check`. After the owner clicked **Run now**:

```
cv-lifecycle-rotation-friday-check
  enabled:    true
  fireAt:     2026-09-11T06:00:00Z
  nextRunAt:  2026-09-11T06:00:00Z     <- still armed
  lastRunAt:  (absent)                 <- but it HAD just run
```

The task folder does not help either: `~/.claude/scheduled-tasks/<id>/` holds only `SKILL.md`, for a
task that has run and for one that never has. Tool approvals granted during a run are stored against
the task but not as a file you can see there.

**Why this matters.** Every task in the list that fired *on schedule* carries a `lastRunAt`, so the
field reads like a reliable "did this run" flag, and the natural check — compare against a task known
to have run — produces a confident WRONG answer. On 2026-09-08 both signals were absent and the
run had in fact succeeded; the owner had to confirm it from the output on his screen. Reporting
"the run did not happen" there would have sent him to click a button he had already clicked.

**How to apply.** To confirm a manual run happened, ask what it PRINTED — never infer it from
`lastRunAt` or the session list. Give any task that may be pre-approved this way a distinctive line
in its own output (a dated dry-run banner is ideal) so the owner's answer is unambiguous. Judge only
`enabled` and `nextRunAt` from `list_scheduled_tasks`: those two ARE reliable, and they answer the
separate question of whether a manual run consumed a one-time `fireAt`. It does not — the task
stays armed.

Same shape as [[a-scheduled-tasks-state-cannot-tell-you-a-job-is-alive]]: a status field that looks
authoritative, is authoritative for the case it was designed for, and is silently empty for the
case you are actually asking about.
