---
name: a-failed-read-that-returns-null-looks-like-a-row-that-never-existed
description: A catch that returns null or [] makes a TIMEOUT indistinguishable from a genuine absence, so the failure renders as a calmer answer rather than an error — pick a shape the two cannot share.
metadata:
  type: project
---

`loadPublicationCellDrift` caught every error and returned `null`. `null` was also what a line with
no publication row returned. On 2026-10-09 `phx_closing_drift_status` answered `canceling statement
due to statement timeout` for CNS 2026-07 and 2026-08 (intermittently — a later run read all three
lines), and the Needs You row came out **one sentence shorter and otherwise identical** to a complete
one. Nothing went amber, nothing logged to the reader, and the row still asserted how many areas had
moved.

The same trap wears `?? 0`, `|| 0`, `catch { return [] }` and `catch { return null }`. The giveaway is
that the fallback value is *also* a legitimate answer.

**Why:** a failed read presented as a quieter answer is worse than an error, because the reader acts
on it. `.claude/rules/portal.md`'s Needs You rule is built on exactly this — a source that fails
produces NO item, because there is no `count` field a failure could write to.

**How to apply:** when a read can fail, make the failure a shape the success cannot take — reject, or
return a discriminated result, or collect the failed key into a named list the caller must print
(`linesNotRead`). Then make the "is it clean?" question go through one helper that is false while that
list has anything in it; `!report.drifted` on its own is the assertion that turns an unread layer into
a calm month. And verify it by RUNNING the thing against production, not by reading it:
[[verify-the-emitted-artifact-never-the-source]] — one period measured 1,670 ms and read fine, while
all three together took 15,352 ms and two of them timed out.
