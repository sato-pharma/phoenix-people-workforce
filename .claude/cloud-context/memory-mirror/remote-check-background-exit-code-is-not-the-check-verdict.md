---
name: remote-check-background-exit-code-is-not-the-check-verdict
description: "A backgrounded remote-check.mjs can surface a notification \"exit code 0\" while the output file's last line reads FAIL — read the file's final `remote-check: PASS/FAIL` line, never the task-notification exit code."
metadata:
  node_type: memory
  type: project
  originSessionId: 842720c6-29b8-44b6-a6a6-776973f2b7dd
  modified: 2026-10-02T19:55:35.342Z
---

When `node scripts/remote-check.mjs <check>` is run as a BACKGROUND task, the task-notification's
`exit code` is NOT the check's verdict. A peer session observed on 2026-10-02 (PR 5169, box head
`c5db05ee7`) a notification reading "completed (exit code 0)" while the same run's output file ended
`remote-check: FAIL — c5db05ee7`. In a PASS case they agree (my own typecheck run the same day,
`672581e53`, showed both "[exited with code 0]" and `--- typecheck PASS ---`), so the quiet danger
is a FAIL that the notification dresses as a pass.

This is a concrete instance of the standing rule [[verify-the-emitted-artifact-never-the-source]]
and the background-notification exit-status trap: the wrapper's status is not the check's.

**Why:** a session that trusts the exit-code summary will merge or ship on a check that actually
failed — the exact "confidently wrong" that costs a day.

**How to apply:** after ANY backgrounded `remote-check.mjs` notification, `Read` the output file and
act on its final `remote-check: PASS — <sha>` / `remote-check: FAIL — <sha>` line only. The same
discipline the peer also noted: that line, not the exit code.

Secondary note from the same peer: remote-check earned its keep immediately — the full off-laptop
suite caught `tests/phoenix-crm-missed-records.test.ts` failing (it pins an idempotency-key spelling
through a regex over source text, so a grep-by-symbol local subset never imported it). The off-laptop
full `test` is the safety net a hand-picked local subset is not.
